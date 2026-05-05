import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * One-shot, idempotent data migrations that run on server boot.
 *
 * Drizzle in this repo is used as a pure schema/query layer (no
 * `drizzle-kit migrate` step is wired up), so domain-level data
 * migrations are applied here at startup. Each step must be safe to
 * re-run on every boot — it should detect "already migrated" state
 * and no-op.
 */
export async function runStartupMigrations(): Promise<void> {
  try {
    // Task #6: the legacy "NEW" workflow step has been retired.
    // Move any workflow still parked in NEW to QUOTATION and record
    // the transition in history so audit trails remain coherent.
    // history.actor_id is NOT NULL, so we attribute the auto-migration
    // to the workflow's original creator (always present, FK-valid).
    const moved = await db.execute(sql`
      WITH updated AS (
        UPDATE workflows
           SET current_step = 'QUOTATION',
               previous_step = 'NEW',
               last_step_change_at = NOW()
         WHERE current_step = 'NEW'
        RETURNING id, created_by_id
      )
      INSERT INTO history (workflow_id, action, from_step, to_step, actor_id, details)
      SELECT id, 'ADVANCE', 'NEW', 'QUOTATION', created_by_id,
             'Auto-migrated: NEW step retired (workflows now start at Quotation)'
        FROM updated
      RETURNING workflow_id
    `);
    const movedCount = Array.isArray((moved as { rows?: unknown[] }).rows)
      ? (moved as { rows: unknown[] }).rows.length
      : 0;
    if (movedCount > 0) {
      logger.info(
        { migrated: movedCount },
        "Startup migration: moved legacy NEW workflows to QUOTATION",
      );
    }
  } catch (err) {
    logger.error({ err: String(err) }, "Startup migration failed");
    // Re-throw so the caller can decide whether to abort startup.
    throw err;
  }
}
