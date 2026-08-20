import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  workflowsTable,
  departmentsTable,
  historyTable,
  usersTable,
  serviceSignaturesTable,
} from "@workspace/db";
import { requireAuth, getUser } from "../middlewares/auth";
import { canSeeWorkflow, hasRole, ACTIVE_WORKFLOW_STEPS } from "../lib/permissions";

const router: IRouter = Router();
const STALL_DAYS = 7;
// Dashboard counters reflect the active flow only — NEW has been
// retired and any legacy rows still in NEW are bucketed into QUOTATION
// for display so the totals match what users see in the UI.
const STEPS = [...ACTIVE_WORKFLOW_STEPS] as string[];

router.get("/dashboard/summary", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  const all = await db
    .select()
    .from(workflowsTable)
    .where(isNull(workflowsTable.deletedAt));
  const visible = all.filter((w) => canSeeWorkflow(user, w.departmentId));
  const counts = new Map<string, number>(STEPS.map((s) => [s, 0]));
  let stalled = 0;
  let totalAge = 0;
  let active = 0;
  let done = 0;
  for (const w of visible) {
    // Legacy NEW rows roll into the QUOTATION bucket so the per-step
    // totals match the active flow that the dashboard renders.
    const bucket = w.currentStep === "NEW" ? "QUOTATION" : w.currentStep;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    const age = Math.floor((Date.now() - new Date(w.lastStepChangeAt).getTime()) / 86_400_000);
    if (w.currentStep === "DONE") done++;
    else {
      active++;
      totalAge += age;
      if (age > STALL_DAYS) stalled++;
    }
  }
  const recentRows = await db
    .select({
      h: historyTable,
      actorName: usersTable.displayName,
      ref: workflowsTable.reference,
    })
    .from(historyTable)
    .leftJoin(usersTable, eq(usersTable.id, historyTable.actorId))
    .leftJoin(workflowsTable, eq(workflowsTable.id, historyTable.workflowId))
    .orderBy(desc(historyTable.createdAt))
    .limit(20);

  const recent = recentRows
    .filter((r) => {
      const wf = visible.find((v) => v.id === r.h.workflowId);
      return !!wf;
    })
    .slice(0, 10);

  res.json({
    totalActive: active,
    totalDone: done,
    stalledCount: stalled,
    averageAgeDays: active > 0 ? Math.round(totalAge / active) : 0,
    countsByStep: STEPS.map((s) => ({ step: s, count: counts.get(s) ?? 0 })),
    recent: recent.map((r) => ({
      id: r.h.id,
      workflowId: r.h.workflowId,
      action: r.h.action,
      fromStep: r.h.fromStep,
      toStep: r.h.toStep,
      actorId: r.h.actorId ?? 0,
      actorName: r.actorName ?? "",
      details: r.h.details ?? `[${r.ref ?? ""}]`,
      createdAt: r.h.createdAt,
    })),
  });
});

// Returns workflows that are waiting for an action from the current
// user — quote validation, service signature, and placing the order
// since the dashboard card lists every workflow the user still has to
// touch. Scoping by role:
//   ADMIN / FINANCIAL_ALL — every action step across all departments
//   GT_INVEST             — GT_INVEST everywhere
//   DEPT_MANAGER          — VALIDATING_QUOTE_FINANCIAL in their depts
// Additionally, anyone whose email matches a PENDING per-service
// signature row sees that workflow regardless of role.
router.get("/dashboard/pending-signatures", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);

  const approvalSteps: string[] = [];
  let restrictDeptIds: number[] | null = null;

  if (hasRole(user, "ADMIN", "FINANCIAL_ALL")) {
    approvalSteps.push(
      "VALIDATING_QUOTE_FINANCIAL",
      "VALIDATING_BY_FINANCIAL",
      "VALIDATING_SERVICES",
      "GT_INVEST",
      "ORDERING",
    );
  } else {
    if (hasRole(user, "GT_INVEST")) {
      approvalSteps.push("GT_INVEST");
    }
    if (hasRole(user, "DEPT_MANAGER")) {
      approvalSteps.push("VALIDATING_QUOTE_FINANCIAL");
      restrictDeptIds = user.departmentIds;
    }
  }

  // Per-service signatures: any user whose email is in a PENDING row's
  // notifiedEmails list also owes a signature on that workflow.
  let serviceSigWorkflowIds: number[] = [];
  if (user.email) {
    const sigRows = await db
      .selectDistinct({ workflowId: serviceSignaturesTable.workflowId })
      .from(serviceSignaturesTable)
      .where(
        and(
          eq(serviceSignaturesTable.status, "PENDING"),
          // notified_emails is a jsonb string[] — match case-insensitively
          // so a user whose Active Directory address differs in casing
          // from the rule still sees their pending signature.
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${serviceSignaturesTable.notifiedEmails}) AS e
            WHERE lower(e) = lower(${user.email})
          )`,
        ),
      );
    serviceSigWorkflowIds = sigRows.map((r) => r.workflowId);
  }

  if (approvalSteps.length === 0 && serviceSigWorkflowIds.length === 0) {
    res.json([]);
    return;
  }

  const stepClause =
    approvalSteps.length > 0
      ? inArray(workflowsTable.currentStep, approvalSteps)
      : undefined;
  const sigClause =
    serviceSigWorkflowIds.length > 0
      ? inArray(workflowsTable.id, serviceSigWorkflowIds)
      : undefined;

  // Match either the role-based step OR a pending service signature
  // addressed to this user's email.
  const matchClause =
    stepClause && sigClause
      ? or(stepClause, sigClause)
      : (stepClause ?? sigClause)!;

  const conditions = [
    isNull(workflowsTable.deletedAt),
    matchClause,
    ...(restrictDeptIds !== null && restrictDeptIds.length > 0
      ? [inArray(workflowsTable.departmentId, restrictDeptIds)]
      : []),
  ];

  const rows = await db
    .select({
      id: workflowsTable.id,
      reference: workflowsTable.reference,
      title: workflowsTable.title,
      currentStep: workflowsTable.currentStep,
      priority: workflowsTable.priority,
      lastStepChangeAt: workflowsTable.lastStepChangeAt,
      departmentName: departmentsTable.name,
    })
    .from(workflowsTable)
    .leftJoin(departmentsTable, eq(departmentsTable.id, workflowsTable.departmentId))
    .where(and(...(conditions as [typeof conditions[0], ...typeof conditions])))
    .orderBy(desc(workflowsTable.lastStepChangeAt));

  res.json(
    rows.map((r) => ({
      id: r.id,
      reference: r.reference,
      title: r.title,
      currentStep: r.currentStep,
      priority: r.priority,
      lastStepChangeAt: r.lastStepChangeAt,
      departmentName: r.departmentName ?? "",
    })),
  );
});

export default router;
