import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import {
  db,
  workflowsTable,
  departmentsTable,
  documentsTable,
  gtInvestDatesTable,
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
    .where(eq(workflowsTable.currentStep, "GT_INVEST"))
    .orderBy(desc(workflowsTable.lastStepChangeAt));
  const visible = rows.filter((r) => canSeeWorkflow(user, r.w.departmentId));
  res.json(
    visible.map((r) => ({
      id: r.w.id,
      reference: r.w.reference,
      title: r.w.title,
      departmentName: r.deptName ?? "",
      estimatedAmount: r.w.estimatedAmount != null ? Number(r.w.estimatedAmount) : null,
      currency: r.w.currency,
      gtInvestDateId: r.w.gtInvestDateId,
      gtInvestComment: r.w.gtInvestComment,
    })),
  );
});

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
    .where(eq(workflowsTable.currentStep, "GT_INVEST"));
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

  // Optionally email it
  if (settings.smtp?.enabled && (settings.gtInvestRecipients?.length ?? 0) > 0) {
    void sendNotification(
      settings.smtp,
      settings.gtInvestRecipients!,
      `GT Invest pack — ${nextDate ? String(nextDate.date) : "next meeting"}`,
      `Attached: GT Invest pack with ${wfs.length} workflows.`,
    );
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="gt-invest-${Date.now()}.pdf"`,
  );
  res.end(Buffer.from(bytes));
});

export default router;
