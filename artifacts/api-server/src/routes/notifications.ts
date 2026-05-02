import { Router, type IRouter } from "express";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();

/**
 * Read-only feed of recent notification fan-outs. Admin-only because the
 * payload includes recipient lists which double as a partial user
 * directory and would leak SMTP failures otherwise.
 */
router.get(
  "/notifications",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const filters: SQL[] = [];
    if (req.query.workflowId) {
      const wid = Number(req.query.workflowId);
      if (Number.isFinite(wid))
        filters.push(eq(notificationsTable.workflowId, wid));
    }
    if (typeof req.query.status === "string") {
      filters.push(eq(notificationsTable.status, req.query.status));
    }
    const rows = await db
      .select()
      .from(notificationsTable)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(notificationsTable.createdAt))
      .limit(limit);
    res.json(rows);
  },
);

export default router;
