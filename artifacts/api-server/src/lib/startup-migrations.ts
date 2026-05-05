import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { derivePublicationTier, getSettings } from "./settings";

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

    // Tier rule change: only THREE_QUOTES (between Standard and
    // Livre I thresholds) requires three competing quotes. LIVRE_I
    // and LIVRE_II are public-publication regimes with a single
    // awarded supplier and only need one quote. Backfill any rows
    // that were previously flagged as `three_quote_required = true`
    // for a non-THREE_QUOTES tier (or that have a stale tier vs the
    // current settings thresholds and stored quote amounts). Safe
    // to re-run: rows already in the correct state are no-ops.
    const settings = await getSettings();
    type WfRow = {
      id: number;
      quotes: unknown;
      publication_tier: string | null;
      three_quote_required: boolean | null;
    };
    const rowsRes = (await db.execute(sql`
      SELECT id, quotes, publication_tier, three_quote_required
        FROM workflows
       WHERE deleted_at IS NULL
    `)) as { rows?: WfRow[] };
    const allRows = rowsRes.rows ?? [];
    let tierFixed = 0;
    for (const r of allRows) {
      const quotes = Array.isArray(r.quotes)
        ? (r.quotes as Array<{ amount?: number | null }>)
        : [];
      const firstAmount = quotes
        .map((q) => q?.amount)
        .find((a): a is number => a != null);
      const tier = derivePublicationTier(firstAmount, settings);
      const expectedThreeQuote = tier === "THREE_QUOTES";
      if (
        r.publication_tier !== tier ||
        r.three_quote_required !== expectedThreeQuote
      ) {
        await db.execute(sql`
          UPDATE workflows
             SET publication_tier = ${tier},
                 three_quote_required = ${expectedThreeQuote}
           WHERE id = ${r.id}
        `);
        tierFixed += 1;
      }
    }
    if (tierFixed > 0) {
      logger.info(
        { migrated: tierFixed },
        "Startup migration: re-derived publication tier / three_quote_required for existing workflows",
      );
    }
  } catch (err) {
    logger.error({ err: String(err) }, "Startup migration failed");
    // Re-throw so the caller can decide whether to abort startup.
    throw err;
  }
}
