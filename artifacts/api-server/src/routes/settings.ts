import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import multer from "multer";
import {
  db,
  gtInvestDatesTable,
  gtInvestResultsTable,
  usersTable,
} from "@workspace/db";
import {
  UpdateSettingsBody,
  CreateGtInvestDateBody,
  CreateGtInvestResultBody,
  DeleteGtInvestDateParams,
  DeleteGtInvestResultParams,
  TestSmtpBody,
} from "@workspace/api-zod";
import nodemailer from "nodemailer";
import { requireAuth, requireRole, getUser } from "../middlewares/auth";
import { getSettings, toPublicSettings, updateSettingsRecord } from "../lib/settings";
import { audit } from "../lib/audit";

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
      // Same explicit-forward treatment for signingAgentPort —
      // null means "not set" and must reach the merge.
      ...("signingAgentPort" in top
        ? { signingAgentPort: top.signingAgentPort ?? null }
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
      const info = await transport.sendMail({
        from: fromAddress ?? username ?? "noreply@example.com",
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
