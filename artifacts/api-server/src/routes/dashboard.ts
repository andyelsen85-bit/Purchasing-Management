import { Router, type IRouter } from "express";
import { desc, eq, isNull } from "drizzle-orm";
import { db, workflowsTable, historyTable, usersTable } from "@workspace/db";
import { requireAuth, getUser } from "../middlewares/auth";
import { canSeeWorkflow, ACTIVE_WORKFLOW_STEPS } from "../lib/permissions";

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

export default router;
