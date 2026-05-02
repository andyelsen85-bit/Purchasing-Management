import { Router, type IRouter } from "express";
import { eq, and, sql, desc } from "drizzle-orm";
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
  canUndo,
  nextStep,
  type WorkflowStep,
} from "../lib/permissions";
import { audit } from "../lib/audit";
import { getSettings } from "../lib/settings";
import { sendNotification } from "../lib/email";

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

async function loadWorkflowFull(id: number) {
  const [w] = await db
    .select({
      w: workflowsTable,
      deptName: departmentsTable.name,
      creatorName: usersTable.displayName,
    })
    .from(workflowsTable)
    .leftJoin(departmentsTable, eq(departmentsTable.id, workflowsTable.departmentId))
    .leftJoin(usersTable, eq(usersTable.id, workflowsTable.createdById))
    .where(eq(workflowsTable.id, id));
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
    isStalled: ageDays > STALL_DAYS && wf.currentStep !== "DONE",
  };
}

router.get("/workflows", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  const params = ListWorkflowsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const conditions = [];
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
    .where(conditions.length ? and(...conditions) : undefined)
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
  const reference = await generateReference();
  const settings = await getSettings();
  const amount = parsed.data.estimatedAmount ?? null;
  const threeQuoteRequired = amount != null && amount >= settings.limitX;
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
      threeQuoteRequired,
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
  if (b.quotes !== undefined) update.quotes = b.quotes;
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

  // Notification: notify creator + dept users when stage changes
  const settings = await getSettings();
  const [creator] = await db.select().from(usersTable).where(eq(usersTable.id, wf.createdById));
  if (creator?.email) {
    void sendNotification(
      settings.smtp,
      creator.email,
      `${wf.reference}: advanced to ${next}`,
      `Workflow ${wf.reference} (${wf.title}) advanced from ${wf.currentStep} to ${next}.`,
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
  if (!wf.previousStep) {
    res.status(400).json({ error: "No previous step to undo to" });
    return;
  }
  const prev = wf.previousStep;
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
  await db.delete(notesTable).where(eq(notesTable.workflowId, params.data.id));
  await db.delete(historyTable).where(eq(historyTable.workflowId, params.data.id));
  await db.delete(documentsTable).where(eq(documentsTable.workflowId, params.data.id));
  await db.delete(workflowsTable).where(eq(workflowsTable.id, params.data.id));
  await audit(user.id, "WORKFLOW_DELETE", "workflow", params.data.id);
  res.sendStatus(204);
});

export default router;
