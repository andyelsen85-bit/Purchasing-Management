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
    // Add investment_form JSONB column if it doesn't exist yet
    // (idempotent — IF NOT EXISTS makes it safe to run on every boot).
    await db.execute(
      sql`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS investment_form jsonb`,
    );

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

    // Tier rule change (four-tier Q4.1 model): publication tier and
    // `three_quote_required` are now derived from the investment form's
    // `valueTier` + `tier2Choice`, not from quote amounts vs threshold
    // settings. Backfill any workflow whose stored flags disagree with
    // its form. Safe to re-run: rows in the correct state are no-ops.
    // Workflows whose form has no `valueTier` (legacy / not-yet-filled)
    // are left untouched so we don't overwrite valid historical values.
    type WfRow = {
      id: number;
      investment_form: unknown;
      publication_tier: string | null;
      three_quote_required: boolean | null;
    };
    const rowsRes = (await db.execute(sql`
      SELECT id, investment_form, publication_tier, three_quote_required
        FROM workflows
       WHERE deleted_at IS NULL
    `)) as { rows?: WfRow[] };
    const allRows = rowsRes.rows ?? [];
    let tierFixed = 0;
    for (const r of allRows) {
      const f = (r.investment_form ?? {}) as {
        valueTier?: string | null;
        tier2Choice?: string | null;
      };
      if (!f.valueTier) continue;
      const tier: "STANDARD" | "THREE_QUOTES" | "LIVRE_I" | "LIVRE_II" =
        f.valueTier === "TIER_2"
          ? f.tier2Choice === "LIVRE_I_EXCEPTION"
            ? "LIVRE_I"
            : "THREE_QUOTES"
          : f.valueTier === "TIER_3" || f.valueTier === "TIER_4"
            ? "LIVRE_II"
            : "STANDARD";
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

    // Juridique notification rules: legacy installs had separate rows
    // per question (q_4_1_1, q_4_1_3, q_7_1, q_7_3) all pointing at the
    // same Service juridique. Consolidate them into a single q_legal
    // rule so admins see one mailing list instead of several. Unions
    // emails + ad_group, rewires any service_signatures references,
    // then deletes the legacy rows. Idempotent.
    const legacyRowsRes = (await db.execute(sql`
      SELECT key, ad_group, emails
        FROM notification_rules
       WHERE key IN ('q_4_1_1','q_4_1_3','q_7_1','q_7_3')
    `)) as { rows?: Array<{ key: string; ad_group: string | null; emails: unknown }> };
    const legacyRows = legacyRowsRes.rows ?? [];
    if (legacyRows.length > 0) {
      const mergedLabel =
        "Q4.1.1 / 4.1.3 / 7.1 / 7.3 — Cadre légal · Service juridique";
      const mergedEmails = new Set<string>();
      let mergedAdGroup: string | null = null;
      for (const r of legacyRows) {
        if (Array.isArray(r.emails)) {
          for (const e of r.emails as unknown[]) {
            if (typeof e === "string" && e.trim()) mergedEmails.add(e.trim());
          }
        }
        if (!mergedAdGroup && r.ad_group && r.ad_group.trim()) {
          mergedAdGroup = r.ad_group.trim();
        }
      }
      const existingLegalRes = (await db.execute(sql`
        SELECT id, ad_group, emails FROM notification_rules WHERE key = 'q_legal'
      `)) as { rows?: Array<{ id: number; ad_group: string | null; emails: unknown }> };
      const existingLegal = existingLegalRes.rows?.[0];
      if (existingLegal) {
        if (Array.isArray(existingLegal.emails)) {
          for (const e of existingLegal.emails as unknown[]) {
            if (typeof e === "string" && e.trim()) mergedEmails.add(e.trim());
          }
        }
        if (!mergedAdGroup && existingLegal.ad_group) {
          mergedAdGroup = existingLegal.ad_group;
        }
        await db.execute(sql`
          UPDATE notification_rules
             SET label = ${mergedLabel},
                 emails = ${JSON.stringify([...mergedEmails])}::jsonb,
                 ad_group = ${mergedAdGroup}
           WHERE key = 'q_legal'
        `);
      } else {
        await db.execute(sql`
          INSERT INTO notification_rules (key, label, emails, ad_group)
          VALUES ('q_legal', ${mergedLabel},
                  ${JSON.stringify([...mergedEmails])}::jsonb,
                  ${mergedAdGroup})
        `);
      }
      // Rewire any service_signatures rows that still reference the
      // legacy keys so they point at q_legal (preserves history).
      await db.execute(sql`
        UPDATE service_signatures
           SET rule_key = 'q_legal',
               rule_label = ${mergedLabel}
         WHERE rule_key IN ('q_4_1_1','q_4_1_3','q_7_1','q_7_3')
      `);
      // Finally drop the legacy rules.
      await db.execute(sql`
        DELETE FROM notification_rules
         WHERE key IN ('q_4_1_1','q_4_1_3','q_7_1','q_7_3')
      `);
      logger.info(
        { merged: legacyRows.map((r) => r.key) },
        "Startup migration: merged legacy juridique notification rules into q_legal",
      );
    }
  } catch (err) {
    logger.error({ err: String(err) }, "Startup migration failed");
    // Re-throw so the caller can decide whether to abort startup.
    throw err;
  }
}
