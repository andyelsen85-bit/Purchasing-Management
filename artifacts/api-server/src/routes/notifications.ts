import { Router, type IRouter } from "express";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";
import { getSettings } from "../lib/settings";
import { flushNotificationQueue } from "../lib/email";

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

/**
 * Returns the current state of the notification batch queue:
 * pending count, interval, last sent time, and computed next send time.
 */
router.get(
  "/notifications/batch-status",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const settings = await getSettings();
    const intervalMinutes = settings.notificationIntervalMinutes ?? 15;
    const lastSentAt = settings.notificationLastSentAt ?? null;

    const [{ value: pendingCount }] = await db
      .select({ value: count() })
      .from(notificationsTable)
      .where(eq(notificationsTable.status, "QUEUED"));

    let nextSendAt: string | null = null;
    if (lastSentAt) {
      const next = new Date(lastSentAt).getTime() + intervalMinutes * 60 * 1000;
      nextSendAt = new Date(next).toISOString();
    }

    res.json({
      pendingCount: Number(pendingCount),
      intervalMinutes,
      lastSentAt,
      nextSendAt,
    });
  },
);

/**
 * Admin-triggered immediate flush of all queued notifications.
 * Equivalent to what the scheduled timer does automatically.
 */
router.post(
  "/notifications/flush",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    try {
      const result = await flushNotificationQueue();
      res.json({
        ...result,
        message:
          result.sent > 0
            ? `${result.sent} e-mail(s) envoyé(s) avec succès.`
            : result.skipped > 0
              ? `SMTP désactivé — ${result.skipped} notification(s) ignorée(s).`
              : "Aucune notification en attente.",
      });
    } catch (err) {
      req.log.warn({ err: String(err) }, "Manual notification flush failed");
      res.status(500).json({ error: "Flush failed", message: String(err) });
    }
  },
);

export default router;
