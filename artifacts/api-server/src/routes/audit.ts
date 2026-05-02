import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, auditLogTable, usersTable } from "@workspace/db";
import { ListAuditLogQueryParams } from "@workspace/api-zod";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();

router.get(
  "/audit-log",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const params = ListAuditLogQueryParams.safeParse(req.query);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const limit = params.data.limit ?? 200;
    const rows = await db
      .select({
        a: auditLogTable,
        actorName: usersTable.displayName,
      })
      .from(auditLogTable)
      .leftJoin(usersTable, eq(usersTable.id, auditLogTable.actorId))
      .orderBy(desc(auditLogTable.createdAt))
      .limit(limit);
    res.json(
      rows.map((r) => ({
        id: r.a.id,
        actorId: r.a.actorId,
        actorName: r.actorName ?? null,
        action: r.a.action,
        target: r.a.target,
        targetId: r.a.targetId,
        ip: r.a.ip,
        details: r.a.details,
        createdAt: r.a.createdAt,
      })),
    );
  },
);

export default router;
