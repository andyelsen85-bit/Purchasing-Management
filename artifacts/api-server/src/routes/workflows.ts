import { Router, type IRouter } from "express";
import { eq, and, sql, desc, isNull, isNotNull } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  db,
  workflowsTable,
  departmentsTable,
  usersTable,
  historyTable,
  documentsTable,
  notesTable,
} from "@workspace/db";
import {
  CreateWorkflowBody,
  UpdateWorkflowBody,
  UpdateWorkflowParams,
  AdvanceWorkflowBody,
  AdvanceWorkflowParams,
  RejectWorkflowBody,
  RejectWorkflowParams,
  SetGtInvestDecisionBody,
  SetGtInvestDecisionParams,
  UndoWorkflowParams,
  GetWorkflowParams,
  DeleteWorkflowParams,
  ListWorkflowsQueryParams,
} from "@workspace/api-zod";
import { requireAuth, getUser } from "../middlewares/auth";
import {
  canActOnStep,
  canSeeWorkflow,
  canViewAll,
  canCreateInDepartment,
  canUndo,
  nextStep,
  type WorkflowStep,
} from "../lib/permissions";
import { audit } from "../lib/audit";
import { getSettings } from "../lib/settings";
import { sendNotification, recipientsForStep } from "../lib/email";

const router: IRouter = Router();

const STALL_DAYS = 7;

function computeAge(d: Date): number {
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000),
  );
}

async function generateReference(): Promise<string> {
  const year = new Date().getFullYear();
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workflowsTable);
  return `PO-${year}-${String((count ?? 0) + 1).padStart(5, "0")}`;
}

async function loadWorkflowFull(id: number, includeDeleted = false) {
  const [w] = await db
    .select({
      w: workflowsTable,
      deptName: departmentsTable.name,
      creatorName: usersTable.displayName,
    })
    .from(workflowsTable)
    .leftJoin(departmentsTable, eq(departmentsTable.id, workflowsTable.departmentId))
    .leftJoin(usersTable, eq(usersTable.id, workflowsTable.createdById))
    .where(
      includeDeleted
        ? eq(workflowsTable.id, id)
        : and(eq(workflowsTable.id, id), isNull(workflowsTable.deletedAt)),
    );
  if (!w) return null;
  const wf = w.w;
  const ageDays = computeAge(wf.lastStepChangeAt);
  return {
    ...wf,
    estimatedAmount: wf.estimatedAmount != null ? Number(wf.estimatedAmount) : null,
    invoiceAmount: wf.invoiceAmount != null ? Number(wf.invoiceAmount) : null,
    departmentName: w.deptName ?? "",
    createdByName: w.creatorName ?? "",
    ageDays,
    isStalled:
      ageDays > STALL_DAYS &&
      wf.currentStep !== "DONE" &&
      wf.currentStep !== "REJECTED",
  };
}

router.get("/workflows", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  const params = ListWorkflowsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const conditions = [isNull(workflowsTable.deletedAt)];
  if (params.data.departmentId)
    conditions.push(eq(workflowsTable.departmentId, params.data.departmentId));
  if (params.data.step)
    conditions.push(eq(workflowsTable.currentStep, params.data.step));

  const rows = await db
    .select({
      w: workflowsTable,
      deptName: departmentsTable.name,
      creatorName: usersTable.displayName,
    })
    .from(workflowsTable)
    .leftJoin(departmentsTable, eq(departmentsTable.id, workflowsTable.departmentId))
    .leftJoin(usersTable, eq(usersTable.id, workflowsTable.createdById))
    .where(and(...conditions))
    .orderBy(desc(workflowsTable.updatedAt));

  const filtered = rows.filter((r) => canSeeWorkflow(user, r.w.departmentId));
  res.json(
    filtered.map((r) => {
      const ageDays = computeAge(r.w.lastStepChangeAt);
      return {
        id: r.w.id,
        reference: r.w.reference,
        title: r.w.title,
        departmentId: r.w.departmentId,
        departmentName: r.deptName ?? "",
        priority: r.w.priority,
        currentStep: r.w.currentStep,
        branch: r.w.branch ?? null,
        estimatedAmount: r.w.estimatedAmount != null ? Number(r.w.estimatedAmount) : null,
        currency: r.w.currency,
        ageDays,
        isStalled: ageDays > STALL_DAYS && r.w.currentStep !== "DONE",
        createdByName: r.creatorName ?? "",
        createdAt: r.w.createdAt,
        updatedAt: r.w.updatedAt,
      };
    }),
  );
});

router.get("/workflows/by-step", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  const rows = await db
    .select({
      w: workflowsTable,
      deptName: departmentsTable.name,
    })
    .from(workflowsTable)
    .leftJoin(departmentsTable, eq(departmentsTable.id, workflowsTable.departmentId))
    .where(isNull(workflowsTable.deletedAt))
    .orderBy(desc(workflowsTable.updatedAt));
  const filtered = rows.filter((r) => canSeeWorkflow(user, r.w.departmentId));
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const r of filtered) {
    const ageDays = computeAge(r.w.lastStepChangeAt);
    const arr = grouped.get(r.w.currentStep) ?? [];
    arr.push({
      id: r.w.id,
      reference: r.w.reference,
      title: r.w.title,
      departmentId: r.w.departmentId,
      departmentName: r.deptName ?? "",
      priority: r.w.priority,
      ageDays,
      isStalled: ageDays > STALL_DAYS && r.w.currentStep !== "DONE",
    });
    grouped.set(r.w.currentStep, arr);
  }
  const STEPS = [
    "NEW","QUOTATION","VALIDATING_QUOTE_FINANCIAL","VALIDATING_BY_FINANCIAL",
    "GT_INVEST","ORDERING","DELIVERY","INVOICE","VALIDATING_INVOICE","PAYMENT","DONE",
  ];
  res.json(STEPS.map((s) => ({ step: s, workflows: grouped.get(s) ?? [] })));
});

router.post("/workflows", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateWorkflowBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const user = getUser(req);
  if (!canCreateInDepartment(user, parsed.data.departmentId)) {
    res.status(403).json({
      error:
        "Forbidden — your role cannot create workflows in this department",
    });
    return;
  }
  const reference = await generateReference();
  const settings = await getSettings();
  // The "3 quotes required" flag is now derived from the FIRST quote
  // line entered in the QUOTATION step (see PATCH /workflows/:id), so
  // at creation time it always starts as false. Estimated amount is
  // accepted for backward compatibility but no longer drives the flag.
  const amount = parsed.data.estimatedAmount ?? null;
  const [created] = await db
    .insert(workflowsTable)
    .values({
      reference,
      title: parsed.data.title,
      departmentId: parsed.data.departmentId,
      createdById: user.id,
      priority: parsed.data.priority,
      description: parsed.data.description ?? null,
      category: parsed.data.category ?? null,
      estimatedAmount: amount != null ? String(amount) : null,
      currency: parsed.data.currency ?? settings.currency,
      neededBy: parsed.data.neededBy
        ? new Date(parsed.data.neededBy).toISOString().slice(0, 10)
        : null,
      threeQuoteRequired: false,
      currentStep: "NEW",
    })
    .returning();
  if (created) {
    await db.insert(historyTable).values({
      workflowId: created.id,
      action: "CREATE",
      toStep: "NEW",
      actorId: user.id,
      details: `Created workflow ${reference}`,
    });
    await audit(user.id, "WORKFLOW_CREATE", "workflow", created.id, reference);
  }
  res.status(201).json(await loadWorkflowFull(created!.id));
});

router.get("/workflows/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetWorkflowParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const wf = await loadWorkflowFull(params.data.id);
  if (!wf) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const user = getUser(req);
  if (!canSeeWorkflow(user, wf.departmentId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(wf);
});

router.patch("/workflows/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateWorkflowParams.safeParse(req.params);
  const body = UpdateWorkflowBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const wf = await loadWorkflowFull(params.data.id);
  if (!wf) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const user = getUser(req);
  if (!canActOnStep(user, wf.currentStep as WorkflowStep, wf.departmentId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const update: Record<string, unknown> = {};
  const b = body.data;
  if (b.title != null) update.title = b.title;
  if (b.priority) update.priority = b.priority;
  if (b.description !== undefined) update.description = b.description;
  if (b.category !== undefined) update.category = b.category;
  if (b.estimatedAmount !== undefined)
    update.estimatedAmount = b.estimatedAmount != null ? String(b.estimatedAmount) : null;
  if (b.currency !== undefined) update.currency = b.currency;
  if (b.neededBy !== undefined)
    update.neededBy = b.neededBy ? new Date(b.neededBy).toISOString().slice(0, 10) : null;
  if (b.quotes !== undefined) {
    update.quotes = b.quotes;
    // Re-evaluate the "3 quotes required" rule whenever quotes change.
    // Rule: if the FIRST entered quote amount exceeds the configured
    // limit (settings.limitX), three quotes are required. We look at
    // the first quote with a non-null amount so the UI can pre-fill
    // empty rows without spuriously flipping the flag.
    const settings = await getSettings();
    const firstAmount = b.quotes
      .map((q) => q.amount)
      .find((a): a is number => a != null);
    update.threeQuoteRequired =
      firstAmount != null && firstAmount > settings.limitX;
  }
  if (b.managerApproved !== undefined) update.managerApproved = b.managerApproved;
  if (b.managerComment !== undefined) update.managerComment = b.managerComment;
  if (b.financialApproved !== undefined) update.financialApproved = b.financialApproved;
  if (b.financialComment !== undefined) update.financialComment = b.financialComment;
  if (b.gtInvestDateId !== undefined) update.gtInvestDateId = b.gtInvestDateId;
  if (b.gtInvestResultId !== undefined) update.gtInvestResultId = b.gtInvestResultId;
  if (b.gtInvestComment !== undefined) update.gtInvestComment = b.gtInvestComment;
  if (b.orderNumber !== undefined) update.orderNumber = b.orderNumber;
  if (b.orderDate !== undefined)
    update.orderDate = b.orderDate ? new Date(b.orderDate).toISOString().slice(0, 10) : null;
  if (b.deliveredOn !== undefined)
    update.deliveredOn = b.deliveredOn ? new Date(b.deliveredOn).toISOString().slice(0, 10) : null;
  if (b.deliveryNotes !== undefined) update.deliveryNotes = b.deliveryNotes;
  if (b.invoiceNumber !== undefined) update.invoiceNumber = b.invoiceNumber;
  if (b.invoiceAmount !== undefined)
    update.invoiceAmount = b.invoiceAmount != null ? String(b.invoiceAmount) : null;
  if (b.invoiceDate !== undefined)
    update.invoiceDate = b.invoiceDate ? new Date(b.invoiceDate).toISOString().slice(0, 10) : null;
  if (b.invoiceValidated !== undefined) update.invoiceValidated = b.invoiceValidated;
  if (b.paymentDate !== undefined)
    update.paymentDate = b.paymentDate ? new Date(b.paymentDate).toISOString().slice(0, 10) : null;
  if (b.paymentReference !== undefined) update.paymentReference = b.paymentReference;
  if (b.invoiceValidated === true) {
    update.invoiceSignedBy = user.displayName;
    update.invoiceSignedAt = new Date();
  }
  if (Object.keys(update).length > 0) {
    await db
      .update(workflowsTable)
      .set(update)
      .where(eq(workflowsTable.id, wf.id));
    await db.insert(historyTable).values({
      workflowId: wf.id,
      action: "EDIT",
      fromStep: wf.currentStep,
      toStep: wf.currentStep,
      actorId: user.id,
      details: "Edited fields",
    });
    await audit(user.id, "WORKFLOW_UPDATE", "workflow", wf.id);
  }
  res.json(await loadWorkflowFull(wf.id));
});

// Server-side gating: each step has a set of fields/documents that
// must be filled in before the workflow may move forward. This is
// enforced HERE so the rule cannot be bypassed by anyone — even the
// admins are protected from accidentally skipping required data.
// Returns a human-readable error message when the prereqs are not
// met, or null when the workflow may advance.
async function validateAdvancePrereqs(
  wf: NonNullable<Awaited<ReturnType<typeof loadWorkflowFull>>>,
  branch: string | null,
): Promise<string | null> {
  const docs = await db
    .select({
      kind: documentsTable.kind,
      isCurrent: documentsTable.isCurrent,
    })
    .from(documentsTable)
    .where(eq(documentsTable.workflowId, wf.id));
  const hasDoc = (kind: string) =>
    docs.some((d) => d.kind === kind && d.isCurrent);
  type Q = {
    companyId?: number | null;
    companyName?: string | null;
    amount?: number | null;
    winning?: boolean;
  };
  switch (wf.currentStep) {
    case "NEW":
      return null;
    case "QUOTATION": {
      const quotes = (wf.quotes ?? []) as Q[];
      if (quotes.length === 0)
        return "Add at least one quote before advancing.";
      if (wf.threeQuoteRequired) {
        const filled = quotes.filter(
          (q) => q.amount != null && (q.companyId || q.companyName),
        );
        if (filled.length < 3)
          return "Three quotes are required. Please add at least three suppliers with an amount.";
        const winners = filled.filter((q) => q.winning);
        if (winners.length === 0)
          return "Mark one quote as winning before advancing.";
      } else {
        const first = quotes[0];
        if (
          !first ||
          first.amount == null ||
          !(first.companyId || first.companyName)
        )
          return "Fill in the supplier and amount of the quote before advancing.";
      }
      if (!hasDoc("QUOTE"))
        return "Attach the quote document before advancing.";
      return null;
    }
    case "VALIDATING_QUOTE_FINANCIAL":
      if (!wf.managerApproved)
        return "The department manager must approve before advancing.";
      return null;
    case "VALIDATING_BY_FINANCIAL":
      if (!wf.financialApproved)
        return "Financial must approve before advancing.";
      if (!branch)
        return "Pick a routing branch (K-Order or GT Invest) before advancing.";
      return null;
    case "GT_INVEST":
      // Manual advance from GT_INVEST is no longer the normal path —
      // the dedicated /gt-invest-decision endpoint records the
      // committee's outcome and routes the workflow accordingly.
      // We still allow advancing here for admin recovery, but only
      // when the decision was OK.
      if ((wf as { gtInvestDecision?: string | null }).gtInvestDecision !== "OK")
        return "Record the GT Invest decision before advancing.";
      return null;
    case "ORDERING":
      if (!wf.orderNumber || !wf.orderDate)
        return "Enter the order number and date before advancing.";
      if (!hasDoc("ORDER"))
        return "Attach the order document before advancing.";
      return null;
    case "DELIVERY":
      // The delivery note attachment used to be mandatory, but in
      // practice many suppliers don't issue a printed delivery slip,
      // so the rule blocked legitimate workflows. We still require
      // the delivered-on date so the audit trail is complete; the
      // attachment is now optional.
      if (!wf.deliveredOn)
        return "Enter the delivery date before advancing.";
      return null;
    case "INVOICE":
      if (
        !wf.invoiceNumber ||
        wf.invoiceAmount == null ||
        !wf.invoiceDate
      )
        return "Enter the invoice number, amount, and date before advancing.";
      if (!hasDoc("INVOICE"))
        return "Attach the invoice document before advancing.";
      return null;
    case "VALIDATING_INVOICE":
      if (!wf.invoiceValidated)
        return "Validate the invoice before advancing.";
      return null;
    case "PAYMENT":
      return null;
    default:
      return null;
  }
}

router.post("/workflows/:id/advance", requireAuth, async (req, res): Promise<void> => {
  const params = AdvanceWorkflowParams.safeParse(req.params);
  const body = AdvanceWorkflowBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const wf = await loadWorkflowFull(params.data.id);
  if (!wf) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const user = getUser(req);
  if (!canActOnStep(user, wf.currentStep as WorkflowStep, wf.departmentId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const branch = body.data.branch ?? wf.branch ?? null;
  // Block bypassing steps when the required data isn't there. The
  // error message is surfaced to the client toast so the user knows
  // exactly what's missing instead of a generic 400.
  const gateError = await validateAdvancePrereqs(wf, branch);
  if (gateError) {
    res.status(400).json({ error: gateError, message: gateError });
    return;
  }
  const next = nextStep(wf.currentStep as WorkflowStep, branch);
  if (!next) {
    res.status(400).json({ error: "Workflow already complete" });
    return;
  }
  const update: Record<string, unknown> = {
    currentStep: next,
    previousStep: wf.currentStep,
    lastStepChangeAt: new Date(),
  };
  if (wf.currentStep === "VALIDATING_BY_FINANCIAL" && branch) {
    update.branch = branch;
  }
  await db.update(workflowsTable).set(update).where(eq(workflowsTable.id, wf.id));
  await db.insert(historyTable).values({
    workflowId: wf.id,
    action: "ADVANCE",
    fromStep: wf.currentStep,
    toStep: next,
    actorId: user.id,
    details: branch ? `branch=${branch}` : null,
  });
  await audit(user.id, "WORKFLOW_ADVANCE", "workflow", wf.id, `${wf.currentStep}->${next}`);

  // Notification: route-targeted role recipients per spec
  const settings = await getSettings();
  const recipients = await recipientsForStep(
    { id: wf.id, departmentId: wf.departmentId, createdById: wf.createdById },
    next,
  );
  if (recipients.length > 0) {
    void sendNotification(
      settings.smtp,
      recipients,
      `${wf.reference}: advanced to ${next}`,
      `Workflow ${wf.reference} (${wf.title}) advanced from ${wf.currentStep} to ${next}.\n\nOpen the workflow in Purchasing Management to review.`,
      { workflowId: wf.id, step: next },
    );
  }

  res.json(await loadWorkflowFull(wf.id));
});

router.post("/workflows/:id/reject", requireAuth, async (req, res): Promise<void> => {
  // Reject closes the workflow: it transitions to the terminal
  // REJECTED step from any of the three approval steps. We keep
  // `previousStep` populated so an admin / financial-all can Undo
  // the close back to the approval step if it was a mistake.
  const params = RejectWorkflowParams.safeParse(req.params);
  const body = RejectWorkflowBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const wf = await loadWorkflowFull(params.data.id);
  if (!wf) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const user = getUser(req);
  if (!canActOnStep(user, wf.currentStep as WorkflowStep, wf.departmentId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  // Closing the workflow is allowed from ANY non-terminal step now —
  // a user can change their mind at the quotation stage, the order
  // can be cancelled by the supplier, the delivery may never happen,
  // etc. Only DONE and an already-REJECTED workflow are off-limits.
  const TERMINAL: WorkflowStep[] = ["DONE", "REJECTED"];
  if (TERMINAL.includes(wf.currentStep as WorkflowStep)) {
    res
      .status(400)
      .json({ error: "Workflow is already closed" });
    return;
  }

  const update: Record<string, unknown> = {
    currentStep: "REJECTED",
    previousStep: wf.currentStep,
    lastStepChangeAt: new Date(),
  };
  // Persist the reject decision + comment on the matching step's
  // approval columns so the audit trail and the existing detail UI
  // both surface why the workflow was closed.
  const comment = body.data.comment ?? null;
  switch (wf.currentStep) {
    case "VALIDATING_QUOTE_FINANCIAL":
      update.managerApproved = false;
      update.managerComment = comment;
      break;
    case "VALIDATING_BY_FINANCIAL":
      update.financialApproved = false;
      update.financialComment = comment;
      break;
    case "VALIDATING_INVOICE":
      update.invoiceValidated = false;
      break;
    default:
      // For non-approval steps, persist the close reason as a generic
      // financial comment so the RejectedPanel can still surface it.
      if (comment) update.financialComment = comment;
      break;
  }

  await db.update(workflowsTable).set(update).where(eq(workflowsTable.id, wf.id));
  await db.insert(historyTable).values({
    workflowId: wf.id,
    action: "REJECT",
    fromStep: wf.currentStep,
    toStep: "REJECTED",
    actorId: user.id,
    details: comment ?? null,
  });
  await audit(
    user.id,
    "WORKFLOW_REJECT",
    "workflow",
    wf.id,
    `${wf.currentStep}->REJECTED`,
  );

  // Notify the same recipients we would for an advance, plus the
  // workflow creator so they know the request was closed.
  const settings = await getSettings();
  const recipients = await recipientsForStep(
    { id: wf.id, departmentId: wf.departmentId, createdById: wf.createdById },
    "REJECTED",
  );
  if (recipients.length > 0) {
    void sendNotification(
      settings.smtp,
      recipients,
      `${wf.reference}: rejected and closed`,
      `Workflow ${wf.reference} (${wf.title}) was rejected at ${wf.currentStep} by ${user.displayName} and is now closed.${comment ? `\n\nReason: ${comment}` : ""}`,
      { workflowId: wf.id, step: "REJECTED" },
    );
  }

  res.json(await loadWorkflowFull(wf.id));
});

router.post("/workflows/:id/undo", requireAuth, async (req, res): Promise<void> => {
  const params = UndoWorkflowParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const user = getUser(req);
  if (!canUndo(user)) {
    res.status(403).json({ error: "Only admins or financial-all can undo" });
    return;
  }
  const wf = await loadWorkflowFull(params.data.id);
  if (!wf) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Multi-step undo: derive the previous step from history rather than
  // relying on the (single-slot) `previousStep` column. We look for the
  // most recent forward transition (ADVANCE / REJECT) whose toStep is
  // the current step and rewind to its fromStep. This lets an admin
  // undo as many steps as they like, one click at a time, instead of
  // being limited to the single most-recent ADVANCE.
  const recent = await db
    .select()
    .from(historyTable)
    .where(eq(historyTable.workflowId, wf.id))
    .orderBy(desc(historyTable.createdAt))
    .limit(50);
  const lastForward = recent.find(
    (h) =>
      (h.action === "ADVANCE" || h.action === "REJECT") &&
      h.toStep === wf.currentStep &&
      h.fromStep,
  );
  if (!lastForward || !lastForward.fromStep) {
    res.status(400).json({ error: "No previous step to undo to" });
    return;
  }
  const prev = lastForward.fromStep;
  await db
    .update(workflowsTable)
    .set({
      currentStep: prev,
      previousStep: null,
      lastStepChangeAt: new Date(),
    })
    .where(eq(workflowsTable.id, wf.id));
  await db.insert(historyTable).values({
    workflowId: wf.id,
    action: "UNDO",
    fromStep: wf.currentStep,
    toStep: prev,
    actorId: user.id,
  });
  await audit(user.id, "WORKFLOW_UNDO", "workflow", wf.id, `${wf.currentStep}->${prev}`);
  res.json(await loadWorkflowFull(wf.id));
});

/**
 * Record the GT Invest committee's decision on a workflow currently
 * sitting at GT_INVEST and apply the matching transition in one shot:
 *
 *   OK              → advance to ORDERING
 *   REFUSED         → close the workflow (REJECTED)
 *   POSTPONED       → stay at GT_INVEST, re-assign meeting date
 *   ACCORD_PRINCIPE → stay at GT_INVEST, re-assign meeting date
 *
 * The four decisions are a fixed enum (no admin editing) — see
 * `GtInvestDecision` in the OpenAPI spec.
 */
router.post(
  "/workflows/:id/gt-invest-decision",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = SetGtInvestDecisionParams.safeParse(req.params);
    const body = SetGtInvestDecisionBody.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const wf = await loadWorkflowFull(params.data.id);
    if (!wf) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const user = getUser(req);
    if (!canActOnStep(user, wf.currentStep as WorkflowStep, wf.departmentId)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (wf.currentStep !== "GT_INVEST") {
      const msg = "Workflow is not currently at GT Invest.";
      res.status(400).json({ error: msg, message: msg });
      return;
    }

    const decision = body.data.decision;
    const dateId = body.data.dateId ?? wf.gtInvestDateId ?? null;
    const comment =
      body.data.comment !== undefined ? body.data.comment : wf.gtInvestComment;

    if (
      (decision === "POSTPONED" || decision === "ACCORD_PRINCIPE") &&
      !dateId
    ) {
      const msg = "Pick a meeting date for postponed / accord principe decisions.";
      res.status(400).json({ error: msg, message: msg });
      return;
    }

    let nextStepValue: WorkflowStep = "GT_INVEST";
    if (decision === "OK") nextStepValue = "ORDERING";
    else if (decision === "REFUSED") nextStepValue = "REJECTED";

    const update: Record<string, unknown> = {
      gtInvestDecision: decision,
      gtInvestDateId: dateId,
      gtInvestComment: comment,
      lastStepChangeAt: new Date(),
    };
    let historyAction: "ADVANCE" | "REJECT" | "EDIT" = "EDIT";
    if (nextStepValue !== wf.currentStep) {
      update.currentStep = nextStepValue;
      update.previousStep = wf.currentStep;
      historyAction = nextStepValue === "REJECTED" ? "REJECT" : "ADVANCE";
    }

    await db
      .update(workflowsTable)
      .set(update)
      .where(eq(workflowsTable.id, wf.id));
    await db.insert(historyTable).values({
      workflowId: wf.id,
      action: historyAction,
      fromStep: wf.currentStep,
      toStep: nextStepValue,
      actorId: user.id,
      details: `GT Invest: ${decision}${dateId ? ` (date #${dateId})` : ""}`,
    });
    await audit(
      user.id,
      "GT_INVEST_DECISION",
      "workflow",
      wf.id,
      `${decision}: ${wf.currentStep}->${nextStepValue}`,
    );

    if (historyAction !== "EDIT") {
      const settings = await getSettings();
      const recipients = await recipientsForStep(
        {
          id: wf.id,
          departmentId: wf.departmentId,
          createdById: wf.createdById,
        },
        nextStepValue,
      );
      if (recipients.length > 0) {
        const subjVerb =
          nextStepValue === "REJECTED" ? "rejected and closed" : `advanced to ${nextStepValue}`;
        void sendNotification(
          settings.smtp,
          recipients,
          `${wf.reference}: ${subjVerb}`,
          `Workflow ${wf.reference} (${wf.title}) — GT Invest decision: ${decision}.`,
          { workflowId: wf.id, step: nextStepValue },
        );
      }
    }

    res.json(await loadWorkflowFull(wf.id));
  },
);

/**
 * Merged-PDF export of a single workflow's attachments.
 *
 * Concatenates a cover sheet plus every *current* document attached to
 * the workflow, ordered through the lifecycle:
 *   QUOTE → GT_INVEST_WINNER → ORDER → DELIVERY → INVOICE → OTHER.
 * Non-PDF attachments are represented by a separator page that records
 * the filename and MIME type so reviewers can see what's missing.
 *
 * Available on any non-NEW step so the Validate Invoice screen can
 * print a single signing pack, but also useful earlier in the flow.
 */
router.get(
  "/workflows/:id/export-pdf",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = GetWorkflowParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const user = getUser(req);
    const [wf] = await db
      .select()
      .from(workflowsTable)
      .where(eq(workflowsTable.id, params.data.id));
    if (!wf) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    if (!canSeeWorkflow(user, wf.departmentId)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // Load every current revision; we sort in-memory so the cover sheet
    // and concatenation order are stable regardless of upload order.
    const docs = (
      await db
        .select()
        .from(documentsTable)
        .where(eq(documentsTable.workflowId, wf.id))
    ).filter((d) => d.isCurrent);

    const KIND_ORDER: Record<string, number> = {
      QUOTE: 0,
      GT_INVEST_WINNER: 1,
      ORDER: 2,
      DELIVERY: 3,
      INVOICE: 4,
      OTHER: 5,
    };
    docs.sort((a, b) => {
      const ka = KIND_ORDER[a.kind] ?? 99;
      const kb = KIND_ORDER[b.kind] ?? 99;
      if (ka !== kb) return ka - kb;
      return new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime();
    });

    const merged = await PDFDocument.create();
    const font = await merged.embedFont(StandardFonts.Helvetica);
    const fontBold = await merged.embedFont(StandardFonts.HelveticaBold);

    // ---------------- cover sheet ----------------
    const cover = merged.addPage([595.28, 841.89]); // A4 portrait
    cover.drawText(`${wf.reference} — workflow pack`, {
      x: 50,
      y: 790,
      size: 20,
      font: fontBold,
    });
    cover.drawText(wf.title.slice(0, 90), {
      x: 50,
      y: 762,
      size: 12,
      font,
    });
    const meta: [string, string][] = [
      ["Step", String(wf.currentStep)],
      ["Priority", String(wf.priority)],
      ["Estimated", `${wf.estimatedAmount ?? "?"} ${wf.currency ?? ""}`],
      [
        "Created",
        new Date(wf.createdAt).toISOString().slice(0, 10),
      ],
      ["Documents", String(docs.length)],
    ];
    let y = 730;
    for (const [k, v] of meta) {
      cover.drawText(`${k}:`, { x: 50, y, size: 10, font: fontBold });
      cover.drawText(v, { x: 130, y, size: 10, font });
      y -= 16;
    }
    y -= 8;
    cover.drawText("Contents", { x: 50, y, size: 12, font: fontBold });
    y -= 18;
    for (const d of docs) {
      if (y < 60) break;
      const line = `• [${d.kind}] ${d.filename} (v${d.version}, ${d.mimeType})`;
      cover.drawText(line.slice(0, 95), { x: 50, y, size: 9, font });
      y -= 14;
    }

    // ---------------- attachments ----------------
    for (const d of docs) {
      if (d.mimeType === "application/pdf") {
        try {
          const buf = Buffer.from(d.contentBase64, "base64");
          const src = await PDFDocument.load(buf, { ignoreEncryption: true });
          const pages = await merged.copyPages(src, src.getPageIndices());
          for (const p of pages) merged.addPage(p);
        } catch (err) {
          req.log?.warn(
            { err: String(err), workflowId: wf.id, documentId: d.id },
            "Failed to merge PDF",
          );
          const sep = merged.addPage([595.28, 841.89]);
          sep.drawText(`${d.kind} — ${d.filename}`, {
            x: 50,
            y: 780,
            size: 14,
            font: fontBold,
          });
          sep.drawText("This PDF could not be opened and was skipped.", {
            x: 50,
            y: 750,
            size: 10,
            font,
          });
        }
      } else {
        const sep = merged.addPage([595.28, 841.89]);
        sep.drawText(`${d.kind} — ${d.filename}`, {
          x: 50,
          y: 780,
          size: 14,
          font: fontBold,
        });
        sep.drawText(`MIME type: ${d.mimeType}`, {
          x: 50,
          y: 754,
          size: 10,
          font,
        });
        sep.drawText("(Non-PDF attachment cannot be inlined.)", {
          x: 50,
          y: 736,
          size: 10,
          font,
        });
      }
    }

    const bytes = await merged.save();
    await audit(
      user.id,
      "WORKFLOW_EXPORT_PDF",
      "workflow",
      wf.id,
      `${docs.length} documents`,
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${wf.reference}-pack.pdf"`,
    );
    res.end(Buffer.from(bytes));
  },
);

/**
 * Admin-only soft delete. We *flag* the workflow as deleted
 * (`deletedAt` / `deletedById`) instead of removing the row, so the
 * full audit trail (history, notes, documents) is preserved and an
 * admin can restore it from Settings → Trash. Every list/detail
 * query filters `deletedAt IS NULL`, so a soft-deleted workflow
 * disappears from operational views as if it had been deleted.
 */
router.delete("/workflows/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteWorkflowParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const user = getUser(req);
  if (!user.roles.includes("ADMIN")) {
    res.status(403).json({ error: "Only admins can delete workflows" });
    return;
  }
  const [existing] = await db
    .select({ id: workflowsTable.id, deletedAt: workflowsTable.deletedAt })
    .from(workflowsTable)
    .where(eq(workflowsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (existing.deletedAt) {
    // Idempotent — already in the trash.
    res.sendStatus(204);
    return;
  }
  await db
    .update(workflowsTable)
    .set({ deletedAt: new Date(), deletedById: user.id })
    .where(eq(workflowsTable.id, params.data.id));
  await audit(user.id, "WORKFLOW_DELETE", "workflow", params.data.id);
  res.sendStatus(204);
});

/**
 * GET /api/admin/deleted-workflows — admin-only listing of every
 * soft-deleted workflow, used by the Settings → Trash panel to
 * offer restore.
 */
router.get(
  "/admin/deleted-workflows",
  requireAuth,
  async (req, res): Promise<void> => {
    const user = getUser(req);
    if (!user.roles.includes("ADMIN")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const rows = await db
      .select({
        w: workflowsTable,
        deptName: departmentsTable.name,
        deletedByName: usersTable.displayName,
      })
      .from(workflowsTable)
      .leftJoin(
        departmentsTable,
        eq(departmentsTable.id, workflowsTable.departmentId),
      )
      .leftJoin(usersTable, eq(usersTable.id, workflowsTable.deletedById))
      .where(isNotNull(workflowsTable.deletedAt))
      .orderBy(desc(workflowsTable.deletedAt));
    res.json(
      rows.map((r) => ({
        id: r.w.id,
        reference: r.w.reference,
        title: r.w.title,
        departmentId: r.w.departmentId,
        departmentName: r.deptName ?? "",
        currentStep: r.w.currentStep,
        deletedAt: r.w.deletedAt,
        deletedByName: r.deletedByName ?? "",
      })),
    );
  },
);

/**
 * POST /api/workflows/:id/restore — admin-only. Clears the
 * soft-delete flags and bumps `updatedAt` so the workflow re-appears
 * at the top of the active list.
 */
router.post(
  "/workflows/:id/restore",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = DeleteWorkflowParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const user = getUser(req);
    if (!user.roles.includes("ADMIN")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const wf = await loadWorkflowFull(params.data.id, true);
    if (!wf) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!wf.deletedAt) {
      // Nothing to do — already active.
      res.json(wf);
      return;
    }
    await db
      .update(workflowsTable)
      .set({ deletedAt: null, deletedById: null, updatedAt: new Date() })
      .where(eq(workflowsTable.id, params.data.id));
    await audit(user.id, "WORKFLOW_RESTORE", "workflow", params.data.id);
    res.json(await loadWorkflowFull(params.data.id));
  },
);

export default router;
