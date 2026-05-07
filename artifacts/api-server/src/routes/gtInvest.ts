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
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
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

// ── Types ─────────────────────────────────────────────────────────────────────

type WfForPdf = {
  id: number;
  reference: string;
  title: string;
  description?: string | null;
  departmentName: string;
  quotes: unknown;
  estimatedAmount: unknown;
  currency: unknown;
  investmentForm: unknown;
};

type QuoteEntry = { amount?: number | null; winning?: boolean };
type InvForm = { budgetPosition?: string | null };

function getWinningPrice(w: WfForPdf): number | null {
  const qs = (Array.isArray(w.quotes) ? w.quotes : []) as QuoteEntry[];
  const winner = qs.find((q) => q.winning) ?? qs[0] ?? null;
  if (winner?.amount != null) return Number(winner.amount);
  return w.estimatedAmount != null ? Number(w.estimatedAmount) : null;
}

function fmtCurrency(amount: number | null, currency: unknown): string {
  if (amount == null) return "—";
  const cur = String(currency ?? "EUR");
  return (
    amount.toLocaleString("fr-FR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) +
    " " +
    cur
  );
}

function trunc(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ── Shared PDF builder ────────────────────────────────────────────────────────
async function buildMeetingPdf(
  meeting: { id: number; date: string; label?: string | null },
  wfs: WfForPdf[],
  appName: string,
  logWarn?: (msg: object) => void,
): Promise<Uint8Array> {
  // Sort by department name, then by reference within each department
  const sorted = [...wfs].sort((a, b) => {
    const d = a.departmentName.localeCompare(b.departmentName, "fr");
    return d !== 0 ? d : a.reference.localeCompare(b.reference, "fr");
  });

  const merged = await PDFDocument.create();
  const fontReg  = await merged.embedFont(StandardFonts.Helvetica);
  const fontBold = await merged.embedFont(StandardFonts.HelveticaBold);

  // Page dimensions (A4)
  const PW = 595;
  const PH = 842;
  const ML = 40;
  const MR = 40;
  const UW = PW - ML - MR; // 515 pt usable width

  // Layout constants
  const HEADER_H    = 108;
  const HEADER_BOT  = PH - HEADER_H; // 734 — y of bottom edge of header band
  const INFO_H      = 24;            // info/subtitle band below header
  const TH_H        = 22;            // table header row height
  const ROW_H       = 19;            // data row height
  const FOOTER_H    = 28;
  const TABLE_MIN_Y = FOOTER_H + 6;  // lowest y a row may start

  // Colour palette — CHdN navy blue scheme
  const NAVY       = rgb(0.00, 0.22, 0.44);  // #003870
  const NAVY_MID   = rgb(0.00, 0.37, 0.65);  // #005EA6
  const ACCENT     = rgb(0.13, 0.59, 0.84);  // #2196D7
  const ROW_ALT    = rgb(0.93, 0.96, 0.99);  // #EDF4FC
  const INFO_BG    = rgb(0.96, 0.97, 1.00);  // #F5F7FF
  const BORDER     = rgb(0.76, 0.86, 0.94);  // #C2DBF0
  const WHITE      = rgb(1.00, 1.00, 1.00);
  const TXT        = rgb(0.12, 0.12, 0.12);
  const MUTED      = rgb(0.44, 0.44, 0.44);
  const HDR_SUB    = rgb(0.70, 0.86, 0.95);  // light blue for header subtitles

  // Column layout (total = UW = 515)
  // Widths tuned so "Pos. budgétaire" gets enough room for real values
  const COLS = [
    { label: "Département",       x: ML,          w: 95,  align: "left"  },
    { label: "Référence",         x: ML + 95,     w: 72,  align: "left"  },
    { label: "Objet",             x: ML + 167,    w: 138, align: "left"  },
    { label: "Prix TTC",          x: ML + 305,    w: 85,  align: "right" },
    { label: "Position budgét.",  x: ML + 390,    w: 125, align: "left"  },
  ] as const;

  const meetingLabel = `${meeting.date}${meeting.label ? ` — ${meeting.label}` : ""}`;
  const genDate = new Date().toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // ── Inner helpers ───────────────────────────────────────────────────────────

  function drawHeader(page: ReturnType<typeof merged.addPage>, isFirst: boolean, pageNum: number) {
    // Main navy band
    page.drawRectangle({ x: 0, y: HEADER_BOT, width: PW, height: HEADER_H, color: NAVY });
    // Thin accent stripe at bottom of band
    page.drawRectangle({ x: 0, y: HEADER_BOT, width: PW, height: 5, color: ACCENT });
    // Right decorative side strip
    page.drawRectangle({ x: PW - 10, y: HEADER_BOT, width: 10, height: HEADER_H, color: NAVY_MID });

    if (isFirst) {
      page.drawText("GT INVEST PACK", {
        x: ML, y: PH - 43, size: 24, font: fontBold, color: WHITE,
      });
      page.drawText(`Réunion du ${meetingLabel}`, {
        x: ML, y: PH - 67, size: 11, font: fontReg, color: HDR_SUB,
      });
      page.drawText(
        `${sorted.length} dossier${sorted.length !== 1 ? "s" : ""}  ·  ${appName}`,
        { x: ML, y: PH - 85, size: 9, font: fontReg, color: HDR_SUB },
      );
    } else {
      page.drawText("GT INVEST PACK", {
        x: ML, y: PH - 43, size: 20, font: fontBold, color: WHITE,
      });
      page.drawText(`Réunion du ${meetingLabel}  ·  page ${pageNum}`, {
        x: ML, y: PH - 66, size: 10, font: fontReg, color: HDR_SUB,
      });
    }
  }

  function drawInfoBand(page: ReturnType<typeof merged.addPage>) {
    const y = HEADER_BOT - INFO_H;
    page.drawRectangle({ x: 0, y, width: PW, height: INFO_H, color: INFO_BG });
    page.drawLine({ start: { x: 0, y }, end: { x: PW, y }, thickness: 0.5, color: BORDER });
    page.drawText(`Généré le ${genDate}`, {
      x: ML, y: y + 8, size: 7.5, font: fontReg, color: MUTED,
    });
    const right = `${sorted.length} demande${sorted.length !== 1 ? "s" : ""}`;
    page.drawText(right, {
      x: PW - MR - fontReg.widthOfTextAtSize(right, 7.5),
      y: y + 8, size: 7.5, font: fontReg, color: MUTED,
    });
  }

  function drawTableHeader(page: ReturnType<typeof merged.addPage>, y: number) {
    page.drawRectangle({ x: ML, y, width: UW, height: TH_H, color: NAVY_MID });
    for (const col of COLS) {
      const tw = fontBold.widthOfTextAtSize(col.label, 7.5);
      const tx = col.align === "right" ? col.x + col.w - tw - 4 : col.x + 4;
      page.drawText(col.label, { x: tx, y: y + 7, size: 7.5, font: fontBold, color: WHITE });
    }
  }

  function drawFooter(page: ReturnType<typeof merged.addPage>, pageNum: number) {
    page.drawRectangle({ x: 0, y: 0, width: PW, height: FOOTER_H, color: INFO_BG });
    page.drawLine({ start: { x: 0, y: FOOTER_H }, end: { x: PW, y: FOOTER_H }, thickness: 0.5, color: BORDER });
    page.drawText(appName, { x: ML, y: 9, size: 7, font: fontReg, color: MUTED });
    const pg = `Page ${pageNum}`;
    page.drawText(pg, {
      x: PW - MR - fontReg.widthOfTextAtSize(pg, 7),
      y: 9, size: 7, font: fontReg, color: MUTED,
    });
  }

  // ── Cover page(s) ──────────────────────────────────────────────────────────
  let pgNum = 1;
  let cvPage = merged.addPage([PW, PH]);
  drawHeader(cvPage, true, pgNum);
  drawInfoBand(cvPage);
  drawFooter(cvPage, pgNum);

  // Table header starts right below the info band on the first page
  let thY = HEADER_BOT - INFO_H - TH_H;
  drawTableHeader(cvPage, thY);
  let rowY = thY - ROW_H;

  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i];

    if (rowY < TABLE_MIN_Y) {
      pgNum++;
      cvPage = merged.addPage([PW, PH]);
      drawHeader(cvPage, false, pgNum);
      drawFooter(cvPage, pgNum);
      thY = HEADER_BOT - 6 - TH_H;
      drawTableHeader(cvPage, thY);
      rowY = thY - ROW_H;
    }

    // Alternating row background
    if (i % 2 === 1) {
      cvPage.drawRectangle({ x: ML, y: rowY, width: UW, height: ROW_H, color: ROW_ALT });
    }

    // Row bottom border
    cvPage.drawLine({
      start: { x: ML, y: rowY },
      end:   { x: ML + UW, y: rowY },
      thickness: 0.3,
      color: BORDER,
    });

    // Column dividers
    for (let c = 1; c < COLS.length; c++) {
      cvPage.drawLine({
        start: { x: COLS[c].x, y: rowY },
        end:   { x: COLS[c].x, y: rowY + ROW_H },
        thickness: 0.3,
        color: BORDER,
      });
    }

    // Cell values
    const price  = fmtCurrency(getWinningPrice(w), w.currency);
    const inv    = ((w.investmentForm ?? {}) as InvForm);
    const cells: string[] = [
      trunc(w.departmentName, 16),
      trunc(w.reference, 12),
      trunc(w.title, 23),
      price,
      trunc(inv.budgetPosition, 21),
    ];

    for (let c = 0; c < COLS.length; c++) {
      const col  = COLS[c];
      const text = cells[c] ?? "";
      const tw   = fontReg.widthOfTextAtSize(text, 8);
      const tx   = col.align === "right" ? col.x + col.w - tw - 4 : col.x + 4;
      cvPage.drawText(text, { x: tx, y: rowY + 5, size: 8, font: fontReg, color: TXT });
    }

    rowY -= ROW_H;
  }

  // Left and right border lines enclosing the entire table
  const tableTopY    = thY + TH_H;
  const tableBottomY = rowY + ROW_H;
  for (const xPos of [ML, ML + UW]) {
    cvPage.drawLine({
      start: { x: xPos, y: tableBottomY },
      end:   { x: xPos, y: tableTopY },
      thickness: 0.5,
      color: BORDER,
    });
  }
  cvPage.drawLine({
    start: { x: ML, y: tableBottomY },
    end:   { x: ML + UW, y: tableBottomY },
    thickness: 0.5,
    color: BORDER,
  });

  // ── Helper: separator/cover page before each workflow's attachments ─────────
  function drawWorkflowSeparator(
    w: WfForPdf,
    position: number,
    hasAttachment: boolean,
    attachmentFilename: string,
  ) {
    const sep = merged.addPage([PW, PH]);

    // ── Header band ──
    sep.drawRectangle({ x: 0, y: HEADER_BOT, width: PW, height: HEADER_H, color: NAVY });
    sep.drawRectangle({ x: 0, y: HEADER_BOT, width: PW, height: 5, color: ACCENT });
    sep.drawRectangle({ x: PW - 10, y: HEADER_BOT, width: 10, height: HEADER_H, color: NAVY_MID });
    sep.drawText(trunc(w.reference, 38), {
      x: ML, y: PH - 43, size: 20, font: fontBold, color: WHITE,
    });
    sep.drawText(trunc(`${w.departmentName}  ·  ${w.title}`, 72), {
      x: ML, y: PH - 66, size: 10, font: fontReg, color: HDR_SUB,
    });
    // Position badge (top-right of header)
    const badge = `Dossier ${position} / ${sorted.length}`;
    const badgeW = fontBold.widthOfTextAtSize(badge, 9);
    sep.drawText(badge, {
      x: PW - MR - 14 - badgeW, y: PH - 26, size: 9, font: fontBold, color: WHITE,
    });

    // ── Info band ──
    const infoY = HEADER_BOT - INFO_H;
    sep.drawRectangle({ x: 0, y: infoY, width: PW, height: INFO_H, color: INFO_BG });
    sep.drawLine({ start: { x: 0, y: infoY }, end: { x: PW, y: infoY }, thickness: 0.5, color: BORDER });
    sep.drawText("Récapitulatif du dossier", {
      x: ML, y: infoY + 8, size: 7.5, font: fontBold, color: NAVY_MID,
    });
    sep.drawText(`Réunion du ${meetingLabel}`, {
      x: PW - MR - fontReg.widthOfTextAtSize(`Réunion du ${meetingLabel}`, 7.5),
      y: infoY + 8, size: 7.5, font: fontReg, color: MUTED,
    });

    // ── Detail card ──
    const cardX = ML;
    const cardY = infoY - 200;
    const cardW = UW;
    const cardH = 190;
    sep.drawRectangle({ x: cardX, y: cardY, width: cardW, height: cardH, color: INFO_BG });
    sep.drawRectangle({ x: cardX, y: cardY + cardH - 4, width: cardW, height: 4, color: NAVY_MID });
    sep.drawLine({ start: { x: cardX, y: cardY }, end: { x: cardX + cardW, y: cardY }, thickness: 0.5, color: BORDER });
    sep.drawLine({ start: { x: cardX, y: cardY }, end: { x: cardX, y: cardY + cardH }, thickness: 0.5, color: BORDER });
    sep.drawLine({ start: { x: cardX + cardW, y: cardY }, end: { x: cardX + cardW, y: cardY + cardH }, thickness: 0.5, color: BORDER });

    const inv = ((w.investmentForm ?? {}) as InvForm);
    const price = fmtCurrency(getWinningPrice(w), w.currency);
    const rows: [string, string][] = [
      ["Objet",               w.title ?? ""],
      ["Département",         w.departmentName],
      ["Prix TTC",            price],
      ["Position budgétaire", inv.budgetPosition ?? "—"],
      ["Réf. pièce jointe",   attachmentFilename || (hasAttachment ? "voir ci-après" : "aucune pièce jointe PDF")],
    ];
    let ry = cardY + cardH - 22;
    for (const [label, val] of rows) {
      sep.drawText(label, { x: cardX + 12, y: ry, size: 8.5, font: fontBold, color: NAVY_MID });
      sep.drawText(trunc(val, 58), { x: cardX + 150, y: ry, size: 8.5, font: fontReg, color: TXT });
      ry -= 24;
      sep.drawLine({
        start: { x: cardX + 8, y: ry + 14 },
        end:   { x: cardX + cardW - 8, y: ry + 14 },
        thickness: 0.3, color: BORDER,
      });
    }

    // ── "Pièces jointes ci-après" label ──
    const arrowY = cardY - 55;
    sep.drawLine({ start: { x: ML, y: arrowY + 20 }, end: { x: PW - MR, y: arrowY + 20 }, thickness: 1, color: ACCENT });
    const arrow = hasAttachment ? "PIÈCE JOINTE CI-APRÈS  →" : "AUCUNE PIÈCE JOINTE PDF POUR CE DOSSIER";
    const arrowW = fontBold.widthOfTextAtSize(arrow, 12);
    sep.drawText(arrow, {
      x: (PW - arrowW) / 2, y: arrowY, size: 12, font: fontBold,
      color: hasAttachment ? NAVY_MID : MUTED,
    });
    sep.drawLine({ start: { x: ML, y: arrowY - 8 }, end: { x: PW - MR, y: arrowY - 8 }, thickness: 1, color: ACCENT });
  }

  // ── Attachment pages — one separator + docs per workflow ──────────────────
  for (let wi = 0; wi < sorted.length; wi++) {
    const w = sorted[wi];
    const docs = await db
      .select()
      .from(documentsTable)
      .where(eq(documentsTable.workflowId, w.id));
    const winner =
      docs.find((d) => d.kind === "GT_INVEST_WINNER" && d.isCurrent) ??
      docs.find((d) => d.kind === "QUOTE" && d.isCurrent);

    // Always insert a separator page before the attachment (or to note its absence)
    drawWorkflowSeparator(w, wi + 1, !!winner, winner?.filename ?? "");

    if (!winner) continue;

    if (winner.mimeType === "application/pdf") {
      try {
        const buf = Buffer.from(winner.contentBase64, "base64");
        const src = await PDFDocument.load(buf, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        for (const p of pages) merged.addPage(p);
      } catch (err) {
        logWarn?.({ err: String(err), workflowId: w.id, msg: "Failed to merge PDF" });
      }
    } else {
      const info = merged.addPage([PW, PH]);
      info.drawRectangle({ x: 0, y: HEADER_BOT, width: PW, height: HEADER_H, color: NAVY });
      info.drawRectangle({ x: 0, y: HEADER_BOT, width: PW, height: 5, color: ACCENT });
      info.drawRectangle({ x: PW - 10, y: HEADER_BOT, width: 10, height: HEADER_H, color: NAVY_MID });
      info.drawText(trunc(w.reference, 35), {
        x: ML, y: PH - 43, size: 18, font: fontBold, color: WHITE,
      });
      info.drawText(trunc(`${w.departmentName} — ${w.title}`, 70), {
        x: ML, y: PH - 66, size: 10, font: fontReg, color: HDR_SUB,
      });
      info.drawText(`Pièce jointe : ${winner.filename}`, {
        x: ML, y: PH - 180, size: 11, font: fontReg, color: TXT,
      });
      info.drawText(`Type : ${winner.mimeType}`, {
        x: ML, y: PH - 198, size: 9, font: fontReg, color: MUTED,
      });
      info.drawText("(Pièce non-PDF — impossible de l'incorporer dans le pack)", {
        x: ML, y: PH - 216, size: 9, font: fontReg, color: MUTED,
      });
    }
  }

  return merged.save();
}

// ── Per-meeting PDF export (download) ─────────────────────────────────────────
router.get(
  "/gt-invest/dates/:id/export",
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

    const rows = await db
      .select({ w: workflowsTable, deptName: departmentsTable.name })
      .from(workflowsTable)
      .leftJoin(departmentsTable, eq(departmentsTable.id, workflowsTable.departmentId))
      .where(
        and(
          eq(workflowsTable.currentStep, "GT_INVEST"),
          eq(workflowsTable.gtInvestDateId, dateId),
          isNull(workflowsTable.deletedAt),
        ),
      );

    const wfs: WfForPdf[] = rows.map((r) => ({
      id: r.w.id,
      reference: r.w.reference,
      title: r.w.title,
      description: r.w.description,
      departmentName: r.deptName ?? "",
      quotes: r.w.quotes,
      estimatedAmount: r.w.estimatedAmount,
      currency: r.w.currency,
      investmentForm: r.w.investmentForm,
    }));

    const settings = await getSettings();
    const bytes = await buildMeetingPdf(
      meeting,
      wfs,
      settings.appName ?? "GT Invest",
      (msg) => req.log?.warn(msg),
    );
    const safeName = `gt-invest-${meeting.date}${meeting.label ? "-" + meeting.label.replace(/[^A-Za-z0-9_-]+/g, "_") : ""}.pdf`;
    await audit(user.id, "GT_INVEST_EXPORT", "gt-date", dateId, `${wfs.length} workflows`);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.end(Buffer.from(bytes));
  },
);

// ── Per-meeting "notify recipients & mark prepared" ───────────────────────────
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

    const rows = await db
      .select({ w: workflowsTable, deptName: departmentsTable.name })
      .from(workflowsTable)
      .leftJoin(departmentsTable, eq(departmentsTable.id, workflowsTable.departmentId))
      .where(
        and(
          eq(workflowsTable.currentStep, "GT_INVEST"),
          eq(workflowsTable.gtInvestDateId, dateId),
          isNull(workflowsTable.deletedAt),
        ),
      );

    const wfs: WfForPdf[] = rows.map((r) => ({
      id: r.w.id,
      reference: r.w.reference,
      title: r.w.title,
      description: r.w.description,
      departmentName: r.deptName ?? "",
      quotes: r.w.quotes,
      estimatedAmount: r.w.estimatedAmount,
      currency: r.w.currency,
      investmentForm: r.w.investmentForm,
    }));

    const settings = await getSettings();
    const bytes = await buildMeetingPdf(
      meeting,
      wfs,
      settings.appName ?? "GT Invest",
      (msg) => req.log?.warn(msg),
    );

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

    const packFilename = `gt-invest-${meeting.date}${meeting.label ? "-" + meeting.label.replace(/[^A-Za-z0-9_-]+/g, "_") : ""}.pdf`;
    let sent = false;
    if (settings.smtp?.enabled && recipients.length > 0) {
      sent = await sendNotification(
        settings.smtp,
        recipients,
        `GT Invest pack — ${meeting.date}${meeting.label ? ` (${meeting.label})` : ""}`,
        `Attached: GT Invest pack with ${wfs.length} workflow(s) for the meeting on ${meeting.date}.`,
        undefined,
        [
          {
            filename: packFilename,
            content: Buffer.from(bytes),
            contentType: "application/pdf",
          },
        ],
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

    res.json({
      sent,
      recipients,
      workflowCount: wfs.length,
      preparedAt: now.toISOString(),
    });
  },
);

export default router;
