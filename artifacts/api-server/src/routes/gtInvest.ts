import { Router, type IRouter } from "express";
import { eq, and, desc, inArray, isNull } from "drizzle-orm";
import {
  db,
  workflowsTable,
  departmentsTable,
  documentsTable,
  gtInvestDatesTable,
  usersTable,
} from "@workspace/db";
import { PDFDocument } from "pdf-lib";
import { requireAuth, getUser } from "../middlewares/auth";
import { canSeeWorkflow, hasRole } from "../lib/permissions";
import { getSettings } from "../lib/settings";
import { sendNotification } from "../lib/email";
import { audit } from "../lib/audit";

const router: IRouter = Router();

router.get("/gt-invest/workflows", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  const rows = await db
    .select({
      w: workflowsTable,
      deptName: departmentsTable.name,
    })
    .from(workflowsTable)
    .leftJoin(departmentsTable, eq(departmentsTable.id, workflowsTable.departmentId))
    .where(
      and(
        eq(workflowsTable.currentStep, "GT_INVEST"),
        isNull(workflowsTable.deletedAt),
      ),
    )
    .orderBy(desc(workflowsTable.lastStepChangeAt));
  const visible = rows.filter((r) => canSeeWorkflow(user, r.w.departmentId));
  const STALL_DAYS = 7;
  const creatorIds = Array.from(new Set(visible.map((r) => r.w.createdById)));
  const usersRows = creatorIds.length
    ? await db.select().from(usersTable).where(inArray(usersTable.id, creatorIds))
    : [];
  const userById = new Map(usersRows.map((u) => [u.id, u.displayName]));
  res.json(
    visible.map((r) => {
      const ageDays = Math.floor(
        (Date.now() - new Date(r.w.lastStepChangeAt).getTime()) / 86_400_000,
      );
      return {
        id: r.w.id,
        reference: r.w.reference,
        title: r.w.title,
        departmentId: r.w.departmentId,
        departmentName: r.deptName ?? "",
        priority: r.w.priority,
        currentStep: r.w.currentStep,
        branch: r.w.branch ?? null,
        estimatedAmount: r.w.estimatedAmount != null ? Number(r.w.estimatedAmount) : null,
        currency: r.w.currency,
        ageDays,
        isStalled: ageDays > STALL_DAYS,
        createdByName: userById.get(r.w.createdById) ?? "",
        createdAt: r.w.createdAt,
        updatedAt: r.w.updatedAt ?? r.w.lastStepChangeAt,
        gtInvestDateId: r.w.gtInvestDateId ?? null,
        gtInvestPreparedAt: r.w.gtInvestPreparedAt
          ? new Date(r.w.gtInvestPreparedAt).toISOString()
          : null,
      };
    }),
  );
});

// Per-meeting "notify recipients & mark prepared" action. Bundles the
// merged-PDF build + send into a single op so the operator never has
// to think about it. Idempotent / re-runnable: each call refreshes
// the timestamp on the meeting and on every workflow currently in
// it. New workflows joining the meeting later show up without the
// stamp, prompting a re-run.
router.post(
  "/gt-invest/dates/:id/notify",
  requireAuth,
  async (req, res): Promise<void> => {
    const user = getUser(req);
    if (!hasRole(user, "GT_INVEST", "FINANCIAL_ALL", "ADMIN")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const dateId = Number(req.params.id);
    if (!Number.isFinite(dateId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [meeting] = await db
      .select()
      .from(gtInvestDatesTable)
      .where(eq(gtInvestDatesTable.id, dateId));
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    const wfs = await db
      .select()
      .from(workflowsTable)
      .where(
        and(
          eq(workflowsTable.currentStep, "GT_INVEST"),
          eq(workflowsTable.gtInvestDateId, dateId),
          isNull(workflowsTable.deletedAt),
        ),
      );

    // Build the merged PDF for this meeting only.
    const merged = await PDFDocument.create();
    const helveticaFont = await merged.embedFont("Helvetica");
    const settings = await getSettings();
    const cover = merged.addPage([595.28, 841.89]);
    cover.drawText(`${settings.appName} — GT Invest Pack`, {
      x: 50, y: 780, size: 22, font: helveticaFont,
    });
    cover.drawText(
      `Meeting: ${meeting.date}${meeting.label ? ` — ${meeting.label}` : ""}`,
      { x: 50, y: 750, size: 14, font: helveticaFont },
    );
    cover.drawText(`Workflows: ${wfs.length}`, {
      x: 50, y: 730, size: 12, font: helveticaFont,
    });
    let y = 700;
    for (const w of wfs) {
      if (y < 80) break;
      cover.drawText(
        `• ${w.reference} — ${w.title.slice(0, 60)} (${w.estimatedAmount ?? "?"} ${w.currency ?? ""})`,
        { x: 50, y, size: 10, font: helveticaFont },
      );
      y -= 16;
    }
    for (const w of wfs) {
      const docs = await db
        .select()
        .from(documentsTable)
        .where(eq(documentsTable.workflowId, w.id));
      const winner =
        docs.find((d) => d.kind === "GT_INVEST_WINNER" && d.isCurrent) ??
        docs.find((d) => d.kind === "QUOTE" && d.isCurrent);
      if (!winner) continue;
      if (winner.mimeType === "application/pdf") {
        try {
          const buf = Buffer.from(winner.contentBase64, "base64");
          const src = await PDFDocument.load(buf, { ignoreEncryption: true });
          const pages = await merged.copyPages(src, src.getPageIndices());
          for (const p of pages) merged.addPage(p);
        } catch (err) {
          req.log?.warn({ err: String(err), workflowId: w.id }, "Failed to merge PDF");
        }
      } else {
        const sep = merged.addPage([595.28, 841.89]);
        sep.drawText(`${w.reference} — ${w.title}`, {
          x: 50, y: 780, size: 16, font: helveticaFont,
        });
        sep.drawText(`Attached file: ${winner.filename} (${winner.mimeType})`, {
          x: 50, y: 750, size: 12, font: helveticaFont,
        });
      }
    }
    const bytes = await merged.save();

    // Recipients = manual list from Settings + every user carrying the
    // GT_INVEST_NOTIFICATIONS role who has an email on file (typically
    // populated from AD via the Group → Role mapping). Deduped + lowercased
    // so an AD-synced user listed manually doesn't get two copies.
    const roleUsers = await db.select().from(usersTable);
    const roleEmails = roleUsers
      .filter((u) => (u.roles ?? []).includes("GT_INVEST_NOTIFICATIONS") && u.email)
      .map((u) => u.email as string);
    const recipients = Array.from(
      new Map(
        [...(settings.gtInvestRecipients ?? []), ...roleEmails]
          .map((e) => e.trim())
          .filter(Boolean)
          .map((e) => [e.toLowerCase(), e]),
      ).values(),
    );
    let sent = false;
    if (settings.smtp?.enabled && recipients.length > 0) {
      sent = await sendNotification(
        settings.smtp,
        recipients,
        `GT Invest pack — ${meeting.date}${meeting.label ? ` (${meeting.label})` : ""}`,
        `Attached: GT Invest pack with ${wfs.length} workflow(s) for the meeting on ${meeting.date}.`,
      );
    }

    const now = new Date();
    await db
      .update(gtInvestDatesTable)
      .set({ preparedAt: now, preparedById: user.id })
      .where(eq(gtInvestDatesTable.id, dateId));
    if (wfs.length > 0) {
      await db
        .update(workflowsTable)
        .set({ gtInvestPreparedAt: now })
        .where(
          and(
            eq(workflowsTable.currentStep, "GT_INVEST"),
            eq(workflowsTable.gtInvestDateId, dateId),
            isNull(workflowsTable.deletedAt),
          ),
        );
    }
    await audit(
      user.id,
      "GT_INVEST_NOTIFY",
      "gt-date",
      dateId,
      `${wfs.length} workflows, ${recipients.length} recipients, sent=${sent}`,
    );

    // Keep the bytes around so the response stays small but the audit
    // and the email both reflect the same content. We don't return the
    // PDF here — the caller can hit /gt-invest/export to fetch it.
    void bytes;
    res.json({
      sent,
      recipients,
      workflowCount: wfs.length,
      preparedAt: now.toISOString(),
    });
  },
);

router.get("/gt-invest/export", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  if (!hasRole(user, "GT_INVEST", "FINANCIAL_ALL", "ADMIN")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  // Build merged PDF from each GT_INVEST workflow's winning quote document
  const wfs = await db
    .select()
    .from(workflowsTable)
    .where(
      and(
        eq(workflowsTable.currentStep, "GT_INVEST"),
        isNull(workflowsTable.deletedAt),
      ),
    );
  const merged = await PDFDocument.create();
  const helveticaFont = await merged.embedFont("Helvetica");

  // Cover page
  const cover = merged.addPage([595.28, 841.89]); // A4
  const settings = await getSettings();
  const dates = await db.select().from(gtInvestDatesTable).orderBy(gtInvestDatesTable.date);
  const nextDate = dates.find((d) => new Date(d.date) >= new Date()) ?? dates[dates.length - 1];

  cover.drawText(`${settings.appName} — GT Invest Pack`, {
    x: 50, y: 780, size: 22, font: helveticaFont,
  });
  cover.drawText(`Meeting: ${nextDate ? String(nextDate.date) : "(no date set)"}`, {
    x: 50, y: 750, size: 14, font: helveticaFont,
  });
  cover.drawText(`Workflows: ${wfs.length}`, {
    x: 50, y: 730, size: 12, font: helveticaFont,
  });
  let y = 700;
  for (const w of wfs) {
    if (y < 80) break;
    cover.drawText(
      `• ${w.reference} — ${w.title.slice(0, 60)} (${w.estimatedAmount ?? "?"} ${w.currency ?? ""})`,
      { x: 50, y, size: 10, font: helveticaFont },
    );
    y -= 16;
  }

  for (const w of wfs) {
    // Find winning quote document
    const docs = await db
      .select()
      .from(documentsTable)
      .where(eq(documentsTable.workflowId, w.id));
    const winner =
      docs.find((d) => d.kind === "GT_INVEST_WINNER" && d.isCurrent) ??
      docs.find((d) => d.kind === "QUOTE" && d.isCurrent);
    if (!winner) continue;
    if (winner.mimeType === "application/pdf") {
      try {
        const buf = Buffer.from(winner.contentBase64, "base64");
        const src = await PDFDocument.load(buf, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        for (const p of pages) merged.addPage(p);
      } catch (err) {
        req.log?.warn({ err: String(err), workflowId: w.id }, "Failed to merge PDF");
      }
    } else {
      // Add a separator page noting non-pdf attachment
      const sep = merged.addPage([595.28, 841.89]);
      sep.drawText(`${w.reference} — ${w.title}`, {
        x: 50, y: 780, size: 16, font: helveticaFont,
      });
      sep.drawText(`Attached file: ${winner.filename} (${winner.mimeType})`, {
        x: 50, y: 750, size: 12, font: helveticaFont,
      });
      sep.drawText(`(Non-PDF attachment cannot be inlined.)`, {
        x: 50, y: 730, size: 10, font: helveticaFont,
      });
    }
  }

  const bytes = await merged.save();
  await audit(user.id, "GT_INVEST_EXPORT", "gt-invest", undefined, `${wfs.length} workflows`);

  // Optionally email it (manual list + GT_INVEST_NOTIFICATIONS role members).
  if (settings.smtp?.enabled) {
    const roleUsers = await db.select().from(usersTable);
    const roleEmails = roleUsers
      .filter((u) => (u.roles ?? []).includes("GT_INVEST_NOTIFICATIONS") && u.email)
      .map((u) => u.email as string);
    const exportRecipients = Array.from(
      new Map(
        [...(settings.gtInvestRecipients ?? []), ...roleEmails]
          .map((e) => e.trim())
          .filter(Boolean)
          .map((e) => [e.toLowerCase(), e]),
      ).values(),
    );
    if (exportRecipients.length > 0) {
      void sendNotification(
        settings.smtp,
        exportRecipients,
        `GT Invest pack — ${nextDate ? String(nextDate.date) : "next meeting"}`,
        `Attached: GT Invest pack with ${wfs.length} workflows.`,
      );
    }
    // (No NotificationContext — this is an admin export, not a workflow event.)
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="gt-invest-${Date.now()}.pdf"`,
  );
  res.end(Buffer.from(bytes));
});

export default router;
