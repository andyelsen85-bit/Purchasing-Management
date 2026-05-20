import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, workflowsTable, departmentsTable, historyTable, usersTable } from "@workspace/db";
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

// Returns workflows that are waiting for the current user's signature or
// approval, scoped by their role:
//   ADMIN / FINANCIAL_ALL — all three approval steps across every department
//   FINANCIAL_INVOICE     — VALIDATING_INVOICE across every department
//   DEPT_MANAGER          — VALIDATING_QUOTE_FINANCIAL in their own departments
router.get("/dashboard/pending-signatures", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);

  const approvalSteps: string[] = [];
  let restrictDeptIds: number[] | null = null;

  if (hasRole(user, "ADMIN", "FINANCIAL_ALL")) {
    approvalSteps.push(
      "VALIDATING_QUOTE_FINANCIAL",
      "VALIDATING_BY_FINANCIAL",
      "VALIDATING_INVOICE",
    );
  } else if (hasRole(user, "FINANCIAL_INVOICE")) {
    approvalSteps.push("VALIDATING_INVOICE");
  } else if (hasRole(user, "DEPT_MANAGER")) {
    approvalSteps.push("VALIDATING_QUOTE_FINANCIAL");
    restrictDeptIds = user.departmentIds;
  }

  if (approvalSteps.length === 0) {
    res.json([]);
    return;
  }

  const conditions = [
    isNull(workflowsTable.deletedAt),
    inArray(workflowsTable.currentStep, approvalSteps),
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
