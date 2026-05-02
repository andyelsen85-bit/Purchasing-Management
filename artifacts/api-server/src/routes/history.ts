import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, historyTable, workflowsTable, usersTable } from "@workspace/db";
import { ListWorkflowHistoryParams } from "@workspace/api-zod";
import { requireAuth, getUser } from "../middlewares/auth";
import { canSeeWorkflow } from "../lib/permissions";

const router: IRouter = Router();

router.get(
  "/workflows/:id/history",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = ListWorkflowHistoryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [wf] = await db
      .select()
      .from(workflowsTable)
      .where(eq(workflowsTable.id, params.data.id));
    if (!wf) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!canSeeWorkflow(getUser(req), wf.departmentId)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const rows = await db
      .select({
        h: historyTable,
        actorName: usersTable.displayName,
      })
      .from(historyTable)
      .leftJoin(usersTable, eq(usersTable.id, historyTable.actorId))
      .where(eq(historyTable.workflowId, params.data.id))
      .orderBy(desc(historyTable.createdAt));
    res.json(
      rows.map((r) => ({
        id: r.h.id,
        workflowId: r.h.workflowId,
        action: r.h.action,
        fromStep: r.h.fromStep,
        toStep: r.h.toStep,
        actorName: r.actorName ?? "",
        details: r.h.details,
        createdAt: r.h.createdAt,
      })),
    );
  },
);

export default router;
