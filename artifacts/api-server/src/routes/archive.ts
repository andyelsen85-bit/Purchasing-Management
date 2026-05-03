import { Router, type IRouter } from "express";
import { sql, lt, isNull, inArray, and } from "drizzle-orm";
import {
  db,
  workflowsTable,
  documentsTable,
  documentVersionsTable,
  historyTable,
} from "@workspace/db";
import { requireAuth, requireRole, getUser } from "../middlewares/auth";
import { audit } from "../lib/audit";

const router: IRouter = Router();

/**
 * POST /api/admin/archive-attachments
 *
 * Frees disk space by deleting every attachment (and its version
 * history) belonging to workflows whose `created_at` is older than
 * the supplied cutoff. The workflow row itself, plus its notes,
 * history, audit entries, GT Invest data, etc. are kept intact —
 * only the binary blobs go.
 *
 * Soft-deleted workflows are intentionally excluded: they're already
 * out of operational view and the Trash tab still expects the
 * documents to be there if an admin restores them.
 *
 * `dryRun: true` returns the stats that *would* be freed without
 * touching anything.
 */
router.post(
  "/admin/archive-attachments",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const olderThanDays = Number(req.body?.olderThanDays);
    const dryRun = Boolean(req.body?.dryRun);
    if (!Number.isInteger(olderThanDays) || olderThanDays < 1) {
      res.status(400).json({
        error: "olderThanDays must be a positive integer (>= 1).",
      });
      return;
    }

    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    // Find candidate workflows. We use a single SQL query to grab
    // ids + total attachment size so the dry run is cheap even with
    // tens of thousands of workflows.
    const candidates = await db
      .select({
        id: workflowsTable.id,
        docCount: sql<number>`(
          select count(*)::int from ${documentsTable}
          where ${documentsTable.workflowId} = ${workflowsTable.id}
        )`,
        verCount: sql<number>`(
          select count(*)::int from ${documentVersionsTable}
          where ${documentVersionsTable.workflowId} = ${workflowsTable.id}
        )`,
        bytes: sql<number>`(
          coalesce((
            select sum(${documentsTable.sizeBytes})::bigint from ${documentsTable}
            where ${documentsTable.workflowId} = ${workflowsTable.id}
          ), 0) + coalesce((
            select sum(${documentVersionsTable.sizeBytes})::bigint
            from ${documentVersionsTable}
            where ${documentVersionsTable.workflowId} = ${workflowsTable.id}
          ), 0)
        )::bigint`,
      })
      .from(workflowsTable)
      .where(
        and(
          lt(workflowsTable.createdAt, cutoff),
          isNull(workflowsTable.deletedAt),
        ),
      );

    // Only count workflows that actually have something to free —
    // there's no point recording a history row on a workflow that
    // never had an attachment.
    const affected = candidates.filter(
      (c) => Number(c.docCount) + Number(c.verCount) > 0,
    );
    const workflowsAffected = affected.length;
    const documentsRemoved = affected.reduce(
      (s, c) => s + Number(c.docCount),
      0,
    );
    const versionsRemoved = affected.reduce(
      (s, c) => s + Number(c.verCount),
      0,
    );
    const bytesFreed = affected.reduce((s, c) => s + Number(c.bytes), 0);

    const result = {
      dryRun,
      cutoffIso: cutoff.toISOString(),
      workflowsAffected,
      documentsRemoved,
      versionsRemoved,
      bytesFreed,
    };

    if (dryRun || workflowsAffected === 0) {
      // Still record the dry-run as an audit event so admins can see
      // who probed the archive flow — but no DB mutation otherwise.
      const actor = getUser(req);
      await audit(
        actor.id,
        dryRun ? "ARCHIVE_ATTACHMENTS_DRYRUN" : "ARCHIVE_ATTACHMENTS",
        "system",
        undefined,
        `cutoff=${result.cutoffIso} workflows=${workflowsAffected} docs=${documentsRemoved} versions=${versionsRemoved} bytes=${bytesFreed}`,
        req.ip,
      );
      res.json(result);
      return;
    }

    const ids = affected.map((c) => c.id);
    const actor = getUser(req);

    try {
      await db.transaction(async (tx) => {
        // document_versions has no FK on documents.id, but we delete it
        // first anyway so any human looking at the SQL log sees the
        // child-first order.
        await tx
          .delete(documentVersionsTable)
          .where(inArray(documentVersionsTable.workflowId, ids));
        await tx
          .delete(documentsTable)
          .where(inArray(documentsTable.workflowId, ids));

        // One history row per affected workflow so the workflow detail
        // page explains why the document grid is empty.
        const historyRows = affected.map((c) => ({
          workflowId: c.id,
          action: "ARCHIVE_ATTACHMENTS",
          fromStep: null,
          toStep: null,
          actorId: actor.id,
          details: `Removed ${c.docCount} document(s) and ${c.verCount} version(s) (${Number(
            c.bytes,
          )} bytes) — workflow created before ${result.cutoffIso}.`,
        }));
        if (historyRows.length > 0) {
          await tx.insert(historyTable).values(historyRows);
        }
      });
    } catch (err) {
      req.log?.error({ err }, "archive-attachments failed");
      res
        .status(500)
        .json({ error: `Archive failed: ${(err as Error).message}` });
      return;
    }

    await audit(
      actor.id,
      "ARCHIVE_ATTACHMENTS",
      "system",
      undefined,
      `cutoff=${result.cutoffIso} workflows=${workflowsAffected} docs=${documentsRemoved} versions=${versionsRemoved} bytes=${bytesFreed}`,
      req.ip,
    );

    res.json(result);
  },
);

export default router;
