import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { settingsTable } from "@workspace/db";
import { logger } from "./logger";
import { eq } from "drizzle-orm";
import {
  encryptSettingSecret,
  isSettingSecretEnvelope,
  readSettingSecret,
} from "./secret-crypto";
import {
  decryptAdfsClientSecret,
  encryptAdfsClientSecret,
} from "./adfs";
import type { AppSettings, AdfsConfigStored, LdapConfigStored, SmtpConfigStored } from "./settings";
import { isDefaultBootstrapAdmin } from "./auth";
import { installAndVerifyAuditLogProtection } from "./audit-immutability";

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
    await installAndVerifyAuditLogProtection();
    await migrateSettingsSecrets();
    // Local temporary credentials are explicitly marked so an operator
    // cannot accidentally leave a bootstrap password in service.  The
    // column is additive and safe to repeat on every boot.
    await db.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE
    `);

    // Existing deployments may contain the original admin/admin bootstrap
    // account from before the flag existed.  Verify the actual scrypt hash
    // before flagging it: an operator who changed that account's password
    // must not be forced through a temporary-password flow.  Never log the
    // candidate account or password.
    const bootstrapCandidates = (await db.execute(sql`
      SELECT id, username, source, password_hash
        FROM users
       WHERE lower(username) = 'admin'
         AND source = 'LOCAL'
         AND password_hash IS NOT NULL
         AND must_change_password = FALSE
    `)) as {
      rows?: Array<{
        id: number;
        username: string;
        source: string;
        password_hash: string | null;
      }>;
    };
    for (const candidate of bootstrapCandidates.rows ?? []) {
      if (
        await isDefaultBootstrapAdmin(
          candidate.username,
          candidate.source,
          candidate.password_hash,
        )
      ) {
        await db.execute(sql`
          UPDATE users
             SET must_change_password = TRUE
           WHERE id = ${candidate.id}
             AND must_change_password = FALSE
        `);
      }
    }

    // OIDC identities are deliberately kept separate from users so a
    // username/email rename cannot silently attach an account to another
    // subject.  This is idempotent for existing installations and mirrors
    // the Drizzle schema definition.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS external_identity_mappings (
        id SERIAL PRIMARY KEY,
        provider TEXT NOT NULL,
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM external_identity_mappings
           GROUP BY provider, issuer, subject
          HAVING COUNT(DISTINCT user_id) > 1
        ) THEN
          RAISE EXCEPTION 'Conflicting external identity mappings require administrator review';
        END IF;
        DELETE FROM external_identity_mappings a
         USING external_identity_mappings b
         WHERE a.id > b.id
           AND a.provider = b.provider
           AND a.issuer = b.issuer
           AND a.subject = b.subject;
      END $$;
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS external_identity_provider_issuer_subject_uniq
        ON external_identity_mappings (provider, issuer, subject)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS external_identity_user_idx
        ON external_identity_mappings (user_id)
    `);
    // Clean up impossible legacy rows before adding the FK. This keeps the
    // migration safe for installations that briefly ran without referential
    // integrity and makes retries idempotent.
    await db.execute(sql`
      DELETE FROM external_identity_mappings e
       WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = e.user_id)
    `);
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'external_identity_mappings_user_id_fk'
        ) THEN
          ALTER TABLE external_identity_mappings
            ADD CONSTRAINT external_identity_mappings_user_id_fk
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
        END IF;
      END $$;
    `);

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

    // Commande is now the final actionable step. Workflows already parked
    // in one of the retired post-order states are therefore complete.
    // Preserve the old state in history while normalising the live row.
    const retiredPostOrder = await db.execute(sql`
      WITH candidates AS (
        SELECT id, created_by_id, current_step AS from_step
          FROM workflows
         WHERE current_step IN ('DELIVERY', 'INVOICE', 'VALIDATING_INVOICE', 'PAYMENT')
      ),
      updated AS (
        UPDATE workflows AS w
           SET current_step = 'DONE',
               previous_step = 'ORDERING',
               last_step_change_at = NOW()
          FROM candidates AS c
         WHERE w.id = c.id
        RETURNING c.id, c.created_by_id, c.from_step
      )
      INSERT INTO history (workflow_id, action, from_step, to_step, actor_id, details)
      SELECT id, 'ADVANCE', from_step, 'DONE', created_by_id,
             'Auto-migrated: Commande is now the final workflow step'
        FROM updated
      RETURNING workflow_id
    `);
    const retiredPostOrderCount = Array.isArray(
      (retiredPostOrder as { rows?: unknown[] }).rows,
    )
      ? (retiredPostOrder as { rows: unknown[] }).rows.length
      : 0;
    if (retiredPostOrderCount > 0) {
      logger.info(
        { migrated: retiredPostOrderCount },
        "Startup migration: completed workflows in retired post-order steps",
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
        "Q4.1.1 / 4.1.3 / 7.1 / 7.3 — Cadre légal & Conformité · Service juridique";
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

/**
 * Convert legacy settings secrets before the first request is served. The
 * entire row update is one transaction: a decryption failure aborts without
 * replacing or clearing any value.
 */
export async function migrateSettingsSecrets(): Promise<number> {
  let migrated = 0;
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(settingsTable).limit(1);
    if (!row) return;
    const original = (row.data ?? {}) as Partial<AppSettings>;
    const result = migrateSettingsData(original);
    migrated += result.migrated;
    if (result.migrated > 0) {
      await tx
        .update(settingsTable)
        .set({ data: result.data })
        .where(eq(settingsTable.id, row.id));
    }
  });
  if (migrated > 0) {
    logger.info({ migrated }, "Startup migration: encrypted legacy settings secrets");
  }
  return migrated;
}

export function migrateSettingsData(
  original: Partial<AppSettings>,
): { data: Partial<AppSettings>; migrated: number } {
  const ldap = { ...((original.ldap ?? {}) as LdapConfigStored) };
  const smtp = { ...((original.smtp ?? {}) as SmtpConfigStored) };
  const adfs = { ...((original.adfs ?? {}) as AdfsConfigStored) };
  let migrated = 0;
  if (typeof ldap.bindPassword === "string" && ldap.bindPassword) {
    const read = readSettingSecret(ldap.bindPassword, "ldap.bindPassword");
    if (read.legacy) {
      ldap.bindPassword = encryptSettingSecret(read.value!, "ldap.bindPassword");
      migrated += 1;
    }
  }
  if (typeof smtp.password === "string" && smtp.password) {
    const read = readSettingSecret(smtp.password, "smtp.password");
    if (read.legacy) {
      smtp.password = encryptSettingSecret(read.value!, "smtp.password");
      migrated += 1;
    }
  }
  if (typeof adfs.clientSecretEncrypted === "string" && adfs.clientSecretEncrypted) {
    if (isSettingSecretEnvelope(adfs.clientSecretEncrypted)) {
      const read = readSettingSecret(adfs.clientSecretEncrypted, "adfs.clientSecret");
      if (read.legacy && read.value) {
        adfs.clientSecretEncrypted = encryptAdfsClientSecret(read.value);
        migrated += 1;
      }
    } else {
      const legacy = decryptAdfsClientSecret(adfs.clientSecretEncrypted);
      if (legacy !== null) {
        adfs.clientSecretEncrypted = encryptAdfsClientSecret(legacy);
        migrated += 1;
      }
    }
  }
  return { data: { ...original, ldap, smtp, adfs }, migrated };
}
