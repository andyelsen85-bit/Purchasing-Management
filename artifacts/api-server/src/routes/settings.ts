import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import multer from "multer";
import {
  db,
  gtInvestDatesTable,
  gtInvestResultsTable,
  notificationRulesTable,
  usersTable,
} from "@workspace/db";
import {
  UpdateSettingsBody,
  CreateGtInvestDateBody,
  CreateGtInvestResultBody,
  DeleteGtInvestDateParams,
  DeleteGtInvestResultParams,
  TestSmtpBody,
  UpdateNotificationRuleBody,
  UpdateNotificationRuleParams,
} from "@workspace/api-zod";
import nodemailer from "nodemailer";
import { requireAuth, requireRole, getUser } from "../middlewares/auth";
import { getSettings, toPublicSettings, updateSettingsRecord } from "../lib/settings";
import { audit } from "../lib/audit";
import { resolveGroupMemberEmails } from "../lib/ldap";

const router: IRouter = Router();

router.get("/settings", requireAuth, async (_req, res): Promise<void> => {
  const s = await getSettings();
  res.json(toPublicSettings(s));
});

router.patch(
  "/settings",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const parsed = UpdateSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    // Map the OpenAPI input shape to the stored shape: zod nullish() turns
    // missing values into `null`, but the persisted record uses `undefined`
    // for "not set" (so the merge in updateSettingsRecord skips the key).
    // We also rename `smtp.fromAddress` → `smtp.from` (legacy column name).
    const dropNulls = <T extends Record<string, unknown>>(
      o: T | undefined,
    ): Partial<{ [K in keyof T]: NonNullable<T[K]> }> => {
      if (!o) return {};
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o))
        if (v !== null && v !== undefined) out[k] = v;
      return out as Partial<{ [K in keyof T]: NonNullable<T[K]> }>;
    };
    const { smtp, ldap, gtInvestRecipients, budgetPositions, ...top } = parsed.data;
    const patch: Parameters<typeof updateSettingsRecord>[0] = {
      ...dropNulls(top),
      // `logoDataUrl: null` is the explicit "remove the logo" signal
      // from the Settings page. dropNulls() above would otherwise
      // drop it and the merge in updateSettingsRecord() would
      // preserve the existing logo, so the Remove button silently
      // did nothing across page reloads. Forward null through.
      ...("logoDataUrl" in top ? { logoDataUrl: top.logoDataUrl ?? null } : {}),
      // Same explicit-forward treatment for signingAgentPort and
      // signingAgentToken — null means "not set" and must reach the merge.
      ...("signingAgentPort" in top
        ? { signingAgentPort: top.signingAgentPort ?? null }
        : {}),
      ...("signingAgentToken" in top
        ? { signingAgentToken: top.signingAgentToken ?? null }
        : {}),
      ...(gtInvestRecipients ? { gtInvestRecipients } : {}),
      ...(budgetPositions ? { budgetPositions } : {}),
      ...(ldap ? { ldap: dropNulls(ldap) } : {}),
      ...(smtp
        ? {
            smtp: {
              ...dropNulls({
                enabled: smtp.enabled,
                host: smtp.host,
                port: smtp.port,
                username: smtp.username,
                password: smtp.password,
                secure: smtp.secure,
                skipTlsVerify: smtp.skipTlsVerify,
              }),
              ...(smtp.fromAddress != null ? { from: smtp.fromAddress } : {}),
              ...(smtp.senderName != null ? { senderName: smtp.senderName } : {}),
            },
          }
        : {}),
    };
    const merged = await updateSettingsRecord(patch);
    await audit(getUser(req).id, "SETTINGS_UPDATE", "settings");
    res.json(toPublicSettings(merged));
  },
);

router.get(
  "/settings/gt-invest-dates",
  requireAuth,
  async (_req, res): Promise<void> => {
    const rows = await db
      .select({
        id: gtInvestDatesTable.id,
        date: gtInvestDatesTable.date,
        label: gtInvestDatesTable.label,
        preparedAt: gtInvestDatesTable.preparedAt,
        preparedByName: usersTable.displayName,
      })
      .from(gtInvestDatesTable)
      .leftJoin(usersTable, eq(usersTable.id, gtInvestDatesTable.preparedById))
      .orderBy(gtInvestDatesTable.date);
    res.json(
      rows.map((r) => ({
        id: r.id,
        date: r.date,
        label: r.label,
        preparedAt: r.preparedAt ? new Date(r.preparedAt).toISOString() : null,
        preparedByName: r.preparedByName ?? null,
      })),
    );
  },
);

router.post(
  "/settings/gt-invest-dates",
  requireAuth,
  requireRole("ADMIN", "FINANCIAL_ALL", "GT_INVEST"),
  async (req, res): Promise<void> => {
    const parsed = CreateGtInvestDateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [created] = await db
      .insert(gtInvestDatesTable)
      .values({
        date: new Date(parsed.data.date).toISOString().slice(0, 10),
        label: parsed.data.label ?? null,
      })
      .returning();
    await audit(getUser(req).id, "GT_DATE_CREATE", "gt-date", created!.id);
    res.status(201).json(created);
  },
);

router.delete(
  "/settings/gt-invest-dates/:id",
  requireAuth,
  requireRole("ADMIN", "FINANCIAL_ALL", "GT_INVEST"),
  async (req, res): Promise<void> => {
    const params = DeleteGtInvestDateParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db.delete(gtInvestDatesTable).where(eq(gtInvestDatesTable.id, params.data.id));
    await audit(getUser(req).id, "GT_DATE_DELETE", "gt-date", params.data.id);
    res.sendStatus(204);
  },
);

router.get(
  "/settings/gt-invest-results",
  requireAuth,
  async (_req, res): Promise<void> => {
    const rows = await db.select().from(gtInvestResultsTable).orderBy(gtInvestResultsTable.label);
    res.json(rows);
  },
);

router.post(
  "/settings/gt-invest-results",
  requireAuth,
  requireRole("ADMIN", "FINANCIAL_ALL", "GT_INVEST"),
  async (req, res): Promise<void> => {
    const parsed = CreateGtInvestResultBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [created] = await db
      .insert(gtInvestResultsTable)
      .values({ label: parsed.data.label })
      .returning();
    await audit(getUser(req).id, "GT_RESULT_CREATE", "gt-result", created!.id);
    res.status(201).json(created);
  },
);

router.delete(
  "/settings/gt-invest-results/:id",
  requireAuth,
  requireRole("ADMIN", "FINANCIAL_ALL", "GT_INVEST"),
  async (req, res): Promise<void> => {
    const params = DeleteGtInvestResultParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db.delete(gtInvestResultsTable).where(eq(gtInvestResultsTable.id, params.data.id));
    await audit(getUser(req).id, "GT_RESULT_DELETE", "gt-result", params.data.id);
    res.sendStatus(204);
  },
);

// ──────────────────────────────────────────────────────────────────────
// Notification rules
// ──────────────────────────────────────────────────────────────────────
// One row per "if question X.Y.Z triggers, notify these people" rule.
// The canonical catalogue is seeded on first GET so the Settings panel
// always shows the same list of triggers in the same order — admins
// just fill in the AD group / emails.
const NOTIFICATION_RULE_SEED: ReadonlyArray<{
  key: string;
  label: string;
}> = [
  { key: "q_legal", label: "Q4.1.1 / 4.1.3 / 7.3 — Cadre légal · Service juridique" },
  { key: "q_6_1", label: "Q6.1 — Aménagements · Service Technique" },
  { key: "q_6_3_1_it", label: "Q6.3.1 — Accès systèmes · Service Informatique" },
  { key: "q_6_3_1_security", label: "Q6.3.1 — Accès systèmes · Sécurité Informatique" },
  { key: "q_8_3", label: "Q8.3 — Gaz/produits chimiques · Service Protection et Prévention" },
  { key: "q_9_4", label: "Q9.4 — Hygiène/Nettoyage · Service SPCI" },
  { key: "q_9_5", label: "Q9.5 — Stérilisation · Service Stérilisation" },
];

async function seedNotificationRulesIfEmpty(): Promise<void> {
  const existing = await db.select({ key: notificationRulesTable.key }).from(notificationRulesTable);
  const have = new Set(existing.map((r) => r.key));
  const toInsert = NOTIFICATION_RULE_SEED.filter((r) => !have.has(r.key));
  if (toInsert.length === 0) return;
  await db.insert(notificationRulesTable).values(
    toInsert.map((r) => ({ key: r.key, label: r.label, emails: [] as string[] })),
  );
}

router.get(
  "/settings/notification-rules",
  requireAuth,
  async (_req, res): Promise<void> => {
    await seedNotificationRulesIfEmpty();
    const rows = await db
      .select()
      .from(notificationRulesTable)
      .orderBy(notificationRulesTable.id);
    res.json(rows);
  },
);

router.put(
  "/settings/notification-rules/:id",
  requireAuth,
  requireRole("ADMIN", "FINANCIAL_ALL"),
  async (req, res): Promise<void> => {
    const params = UpdateNotificationRuleParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = UpdateNotificationRuleBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const patch: Record<string, unknown> = {};
    if ("adGroup" in body.data) patch.adGroup = body.data.adGroup ?? null;
    if (body.data.emails) {
      // De-dup + trim while preserving order. Empty strings dropped.
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const raw of body.data.emails) {
        const e = raw.trim();
        if (!e || seen.has(e.toLowerCase())) continue;
        seen.add(e.toLowerCase());
        cleaned.push(e);
      }
      patch.emails = cleaned;
    }
    const [updated] = await db
      .update(notificationRulesTable)
      .set(patch)
      .where(eq(notificationRulesTable.id, params.data.id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Rule not found" });
      return;
    }
    await audit(getUser(req).id, "NOTIFICATION_RULE_UPDATE", "notification-rule", updated.id);
    res.json(updated);
  },
);

router.post(
  "/settings/notification-rules/sync-ad",
  requireAuth,
  requireRole("ADMIN", "FINANCIAL_ALL"),
  async (req, res): Promise<void> => {
    await seedNotificationRulesIfEmpty();
    const settings = await getSettings();
    const ldapCfg = settings.ldap;

    if (!ldapCfg?.enabled || !ldapCfg.host || !ldapCfg.baseDn) {
      res.status(400).json({
        synced: 0,
        message:
          "LDAP / Active Directory n'est pas configuré dans les Paramètres (onglet LDAP). Activez la connexion, renseignez l'hôte et le Base DN, puis réessayez.",
        rules: await db
          .select()
          .from(notificationRulesTable)
          .orderBy(notificationRulesTable.id),
        perRule: [],
      });
      return;
    }
    if (!ldapCfg.bindDn || !ldapCfg.bindPassword) {
      res.status(400).json({
        synced: 0,
        message:
          "Le compte de service LDAP (Bind DN + mot de passe) n'est pas configuré — il est nécessaire pour lire les membres des groupes AD.",
        rules: await db
          .select()
          .from(notificationRulesTable)
          .orderBy(notificationRulesTable.id),
        perRule: [],
      });
      return;
    }

    const rules = await db
      .select()
      .from(notificationRulesTable)
      .orderBy(notificationRulesTable.id);

    let synced = 0;
    const perRule: Array<{
      key: string;
      ok: boolean;
      count: number;
      error?: string;
      details?: string;
    }> = [];

    for (const rule of rules) {
      const group = (rule.adGroup ?? "").trim();
      if (!group) {
        perRule.push({
          key: rule.key,
          ok: true,
          count: rule.emails.length,
          details: "Aucun groupe AD configuré — emails manuels conservés.",
        });
        continue;
      }
      try {
        const r = await resolveGroupMemberEmails(ldapCfg, group);
        if (!r.ok) {
          perRule.push({
            key: rule.key,
            ok: false,
            count: rule.emails.length,
            error: r.error,
          });
          continue;
        }
        await db
          .update(notificationRulesTable)
          .set({ emails: r.emails })
          .where(eq(notificationRulesTable.id, rule.id));
        synced += 1;
        perRule.push({
          key: rule.key,
          ok: true,
          count: r.emails.length,
          details: r.details,
        });
      } catch (err) {
        perRule.push({
          key: rule.key,
          ok: false,
          count: rule.emails.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await audit(getUser(req).id, "NOTIFICATION_RULES_SYNC_AD", "notification-rules");

    const refreshed = await db
      .select()
      .from(notificationRulesTable)
      .orderBy(notificationRulesTable.id);

    const failed = perRule.filter((p) => !p.ok);
    res.json({
      synced,
      message:
        failed.length === 0
          ? `${synced} règle(s) synchronisée(s) depuis Active Directory.`
          : `${synced} règle(s) synchronisée(s), ${failed.length} en échec — voir détails par règle.`,
      rules: refreshed,
      perRule,
    });
  },
);

/**
 * POST /api/admin/smtp-test
 *
 * Sends a test email so the operator can validate their SMTP config
 * without waiting for a real workflow event. Accepts the same fields
 * as the SMTP settings form so the panel can offer "Send test" *before*
 * the operator hits Save. Any field omitted falls back to the saved
 * value — most importantly, omit `password` to reuse the stored one
 * (the GET endpoint never returns it).
 */
router.post(
  "/admin/smtp-test",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const parsed = TestSmtpBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, message: parsed.error.message });
      return;
    }
    const stored = (await getSettings()).smtp;
    const body = parsed.data;
    const host = body.host ?? stored.host ?? null;
    const port = body.port ?? stored.port ?? 587;
    const secure = body.secure ?? stored.secure ?? false;
    const username = body.username ?? stored.username ?? null;
    // Empty string in the form means "no change" — fall through to the
    // stored secret. Only a *populated* override replaces it.
    const password = body.password ? body.password : stored.password ?? null;
    const fromAddress = body.fromAddress ?? stored.from ?? null;
    const senderName = body.senderName ?? stored.senderName ?? null;
    const skipTlsVerify = body.skipTlsVerify ?? stored.skipTlsVerify ?? false;

    if (!host) {
      res.status(400).json({ ok: false, message: "SMTP host is required." });
      return;
    }

    try {
      const transport = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: username && password ? { user: username, pass: password } : undefined,
        ...(skipTlsVerify ? { tls: { rejectUnauthorized: false } } : {}),
      });
      // verify() runs an EHLO (and AUTH if creds are supplied) without
      // sending anything — gives a fast, specific failure when the host
      // or credentials are wrong before we attempt the real send.
      await transport.verify();
      const baseFrom = fromAddress ?? username ?? "noreply@example.com";
      const info = await transport.sendMail({
        from: senderName ? `"${senderName}" <${baseFrom}>` : baseFrom,
        to: body.to,
        subject: "Purchasing Management — SMTP test",
        text:
          "This is a test message sent from the Purchasing Management Settings page.\n\n" +
          "If you received this, your SMTP configuration is working.",
      });
      await audit(
        getUser(req).id,
        "SMTP_TEST",
        "settings",
        undefined,
        `to=${body.to}, host=${host}:${port}`,
      );
      res.json({ ok: true, message: `Sent (id ${info.messageId ?? "?"}) to ${body.to}.` });
    } catch (err) {
      req.log.warn({ err: String(err) }, "SMTP test failed");
      res.json({ ok: false, message: String(err instanceof Error ? err.message : err) });
    }
  },
);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.get(
  "/settings/budget-positions/export",
  requireAuth,
  requireRole("ADMIN"),
  async (_req, res): Promise<void> => {
    const s = await getSettings();
    const positions = s.budgetPositions ?? [];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Positions budgétaires");
    ws.getColumn(1).header = "Position budgétaire";
    ws.getColumn(1).width = 50;
    for (const p of positions) ws.addRow([p]);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="positions-budgetaires.xlsx"');
    await wb.xlsx.write(res as import("stream").Writable);
    res.end();
  },
);

router.post(
  "/settings/budget-positions/import",
  requireAuth,
  requireRole("ADMIN"),
  upload.single("file"),
  async (req, res): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "Fichier manquant." });
      return;
    }
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(req.file.buffer as unknown as any);
    const ws = wb.worksheets[0];
    if (!ws) {
      res.status(400).json({ error: "Aucune feuille trouvée dans le fichier." });
      return;
    }
    const positions: string[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const cell = row.getCell(1);
      const val = String(cell.value ?? "").trim();
      if (val) positions.push(val);
    });
    await updateSettingsRecord({ budgetPositions: positions });
    await audit(getUser(req).id, "SETTINGS_UPDATE", "settings", undefined, "budget-positions-import");
    res.json({ imported: positions.length, positions });
  },
);

export default router;
