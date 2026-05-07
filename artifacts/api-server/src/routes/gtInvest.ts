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

/**
 * Format a price as "1 234,56 EUR" using plain ASCII spaces so WinAnsi
 * can encode the result.  toLocaleString("fr-FR") uses U+202F (narrow
 * no-break space) as the thousands separator which WinAnsi cannot encode.
 */
function fmtCurrency(amount: number | null, currency: unknown): string {
  if (amount == null) return "-";
  const cur = String(currency ?? "EUR");
  const [intStr, decStr] = amount.toFixed(2).split(".");
  const thousands = intStr.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${thousands},${decStr} ${cur}`;
}

function trunc(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Strip / replace any character that WinAnsi (Windows-1252) cannot encode.
 * Keeps Latin-1 (U+0000–U+00FF) and the known Windows-1252 extras intact;
 * replaces Unicode spaces with a plain ASCII space; drops everything else.
 */
function pdfSafe(s: string | null | undefined): string {
  if (!s) return "";
  const WIN1252_EXTRAS = new Set([
    0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6,
    0x2030, 0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C,
    0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A,
    0x0153, 0x017E, 0x0178,
  ]);
  return [...s].map((c) => {
    const cp = c.codePointAt(0)!;
    if (cp <= 0x00FF) return c;                    // Latin-1 — always safe
    if (WIN1252_EXTRAS.has(cp)) return c;           // Win-1252 extras — safe
    if ((cp >= 0x2000 && cp <= 0x200A) ||
        cp === 0x202F || cp === 0x205F) return " "; // Unicode spaces → ASCII space
    return "";                                      // everything else — strip
  }).join("");
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

  // Shared margins
  const ML = 40;
  const MR = 40;

  // Layout constants (shared between orientations)
  const INFO_H      = 24;  // info/subtitle band below header
  const ROW_H       = 19;  // data row height
  const FOOTER_H    = 28;
  const TABLE_MIN_Y = FOOTER_H + 6; // lowest y a row may start

  // Per-orientation dimension packs
  interface PageDims { pw: number; ph: number; uw: number; headerH: number; headerBot: number; }
  // Portrait A4  (595 × 842) — used for separator + attachment pages
  const PORT: PageDims = { pw: 595, ph: 842, uw: 515, headerH: 108, headerBot: 734 };
  // Landscape A4 (842 × 595) — used for the summary/cover table pages
  const LAND: PageDims = { pw: 842, ph: 595, uw: 762, headerH: 80,  headerBot: 515 };

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

  // Column widths for the grouped cover table (landscape UW = 762)
  // Référence | Objet | Prix HTVA
  const COL_REF = 120;
  const COL_OBJ = 510;
  const COL_PRC = 132; // right-aligned price; 120+510+132 = 762 ✓
  const X_REF = ML;
  const X_OBJ = ML + COL_REF;
  const X_PRC = ML + COL_REF + COL_OBJ;
  const DEPT_H = 24; // department group header height
  const POS_H  = 18; // budget-position sub-header + column-label bar height

  const meetingLabel = `${meeting.date}${meeting.label ? ` — ${meeting.label}` : ""}`;
  const genDate = new Date().toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // ── Inner helpers ───────────────────────────────────────────────────────────

  type Page = ReturnType<typeof merged.addPage>;

  function drawHeader(page: Page, d: PageDims, isFirst: boolean, pageNum: number) {
    page.drawRectangle({ x: 0, y: d.headerBot, width: d.pw, height: d.headerH, color: NAVY });
    page.drawRectangle({ x: 0, y: d.headerBot, width: d.pw, height: 5, color: ACCENT });
    page.drawRectangle({ x: d.pw - 10, y: d.headerBot, width: 10, height: d.headerH, color: NAVY_MID });

    if (isFirst) {
      page.drawText("GT INVEST PACK", {
        x: ML, y: d.ph - 43, size: 24, font: fontBold, color: WHITE,
      });
      page.drawText(`Réunion du ${meetingLabel}`, {
        x: ML, y: d.ph - 67, size: 11, font: fontReg, color: HDR_SUB,
      });
      page.drawText(
        `${sorted.length} dossier${sorted.length !== 1 ? "s" : ""}  ·  ${appName}`,
        { x: ML, y: d.ph - 85, size: 9, font: fontReg, color: HDR_SUB },
      );
    } else {
      page.drawText("GT INVEST PACK", {
        x: ML, y: d.ph - 43, size: 20, font: fontBold, color: WHITE,
      });
      page.drawText(`Réunion du ${meetingLabel}  ·  page ${pageNum}`, {
        x: ML, y: d.ph - 66, size: 10, font: fontReg, color: HDR_SUB,
      });
    }
  }

  function drawInfoBand(page: Page, d: PageDims) {
    const y = d.headerBot - INFO_H;
    page.drawRectangle({ x: 0, y, width: d.pw, height: INFO_H, color: INFO_BG });
    page.drawLine({ start: { x: 0, y }, end: { x: d.pw, y }, thickness: 0.5, color: BORDER });
    page.drawText(`Généré le ${genDate}`, {
      x: ML, y: y + 8, size: 7.5, font: fontReg, color: MUTED,
    });
    const right = `${sorted.length} demande${sorted.length !== 1 ? "s" : ""}`;
    page.drawText(right, {
      x: d.pw - MR - fontReg.widthOfTextAtSize(right, 7.5),
      y: y + 8, size: 7.5, font: fontReg, color: MUTED,
    });
  }

  function drawFooter(page: Page, d: PageDims, pageNum: number) {
    page.drawRectangle({ x: 0, y: 0, width: d.pw, height: FOOTER_H, color: INFO_BG });
    page.drawLine({ start: { x: 0, y: FOOTER_H }, end: { x: d.pw, y: FOOTER_H }, thickness: 0.5, color: BORDER });
    page.drawText(appName, { x: ML, y: 9, size: 7, font: fontReg, color: MUTED });
    const pg = `Page ${pageNum}`;
    page.drawText(pg, {
      x: d.pw - MR - fontReg.widthOfTextAtSize(pg, 7),
      y: 9, size: 7, font: fontReg, color: MUTED,
    });
  }

  // ── Build items sorted by dept → budgetPos → reference ────────────────────
  interface PdfItem { deptName: string; budgetPos: string; reference: string; title: string; price: string; }
  const pdfItems: PdfItem[] = sorted.map((w) => {
    const inv = (w.investmentForm ?? {}) as InvForm;
    return {
      deptName:  pdfSafe(w.departmentName) || "-",
      budgetPos: pdfSafe(inv.budgetPosition) || "-",
      reference: pdfSafe(w.reference),
      title:     pdfSafe(w.title ?? ""),
      price:     fmtCurrency(getWinningPrice(w), w.currency),
    };
  }).sort((a, b) => {
    const d = a.deptName.localeCompare(b.deptName, "fr");
    if (d !== 0) return d;
    const p = a.budgetPos.localeCompare(b.budgetPos, "fr");
    if (p !== 0) return p;
    return a.reference.localeCompare(b.reference, "fr");
  });

  // ── Cover page(s) — landscape A4, grouped layout ────────────────────────────
  let pgNum = 1;
  let cvPage = merged.addPage([LAND.pw, LAND.ph]);
  drawHeader(cvPage, LAND, true, pgNum);
  drawInfoBand(cvPage, LAND);
  drawFooter(cvPage, LAND, pgNum);

  let curY = LAND.headerBot - INFO_H - 2;

  /** Draw the Référence / Objet / Prix HTVA column label bar on the current page. */
  function drawColHeader() {
    cvPage.drawRectangle({ x: ML, y: curY - POS_H, width: LAND.uw, height: POS_H, color: NAVY_MID });
    cvPage.drawLine({ start: { x: X_OBJ, y: curY - POS_H }, end: { x: X_OBJ, y: curY }, thickness: 0.3, color: WHITE });
    cvPage.drawLine({ start: { x: X_PRC, y: curY - POS_H }, end: { x: X_PRC, y: curY }, thickness: 0.3, color: WHITE });
    cvPage.drawText("R\xE9f\xE9rence", { x: X_REF + 4, y: curY - POS_H + 5, size: 7.5, font: fontBold, color: WHITE });
    cvPage.drawText("Objet",           { x: X_OBJ + 4, y: curY - POS_H + 5, size: 7.5, font: fontBold, color: WHITE });
    const pL  = "Prix HTVA";
    const pLW = fontBold.widthOfTextAtSize(pL, 7.5);
    cvPage.drawText(pL, { x: X_PRC + COL_PRC - pLW - 4, y: curY - POS_H + 5, size: 7.5, font: fontBold, color: WHITE });
    curY -= POS_H;
  }

  drawColHeader();

  /** Open a new landscape page and re-print the running context headers. */
  function newCoverPage(contDept: string, contPos: string) {
    pgNum++;
    cvPage = merged.addPage([LAND.pw, LAND.ph]);
    drawHeader(cvPage, LAND, false, pgNum);
    drawFooter(cvPage, LAND, pgNum);
    curY = LAND.headerBot - 6;
    drawColHeader();
    if (contDept) {
      cvPage.drawRectangle({ x: ML, y: curY - DEPT_H, width: LAND.uw, height: DEPT_H, color: NAVY });
      cvPage.drawText(trunc(contDept + " (suite)", 80), {
        x: ML + 8, y: curY - DEPT_H + 8, size: 10, font: fontBold, color: WHITE,
      });
      curY -= DEPT_H;
    }
    if (contPos) {
      cvPage.drawRectangle({ x: ML, y: curY - POS_H, width: LAND.uw, height: POS_H, color: NAVY_MID });
      cvPage.drawText(trunc(contPos, 80), {
        x: ML + 16, y: curY - POS_H + 5, size: 8, font: fontBold, color: WHITE,
      });
      curY -= POS_H;
    }
  }

  let lastDept = "";
  let lastPos  = "";
  let rowAlt   = false;

  for (const item of pdfItems) {
    // ── Department header ──────────────────────────────────────────────────
    if (item.deptName !== lastDept) {
      if (curY - DEPT_H - POS_H - ROW_H < TABLE_MIN_Y) newCoverPage("", "");
      cvPage.drawRectangle({ x: ML, y: curY - DEPT_H, width: LAND.uw, height: DEPT_H, color: NAVY });
      cvPage.drawText(trunc(item.deptName, 80), {
        x: ML + 8, y: curY - DEPT_H + 8, size: 10, font: fontBold, color: WHITE,
      });
      curY -= DEPT_H;
      lastDept = item.deptName;
      lastPos  = "";
      rowAlt   = false;
    }

    // ── Budget-position sub-header ─────────────────────────────────────────
    if (item.budgetPos !== lastPos) {
      if (curY - POS_H - ROW_H < TABLE_MIN_Y) newCoverPage(lastDept, "");
      cvPage.drawRectangle({ x: ML, y: curY - POS_H, width: LAND.uw, height: POS_H, color: NAVY_MID });
      cvPage.drawText(trunc(item.budgetPos, 80), {
        x: ML + 16, y: curY - POS_H + 5, size: 8, font: fontBold, color: WHITE,
      });
      curY -= POS_H;
      lastPos = item.budgetPos;
      rowAlt  = false;
    }

    // ── Demand row ────────────────────────────────────────────────────────
    if (curY - ROW_H < TABLE_MIN_Y) newCoverPage(lastDept, lastPos);
    if (rowAlt) {
      cvPage.drawRectangle({ x: ML, y: curY - ROW_H, width: LAND.uw, height: ROW_H, color: ROW_ALT });
    }
    cvPage.drawLine({ start: { x: ML,    y: curY - ROW_H }, end: { x: ML + LAND.uw, y: curY - ROW_H }, thickness: 0.3, color: BORDER });
    cvPage.drawLine({ start: { x: X_OBJ, y: curY - ROW_H }, end: { x: X_OBJ,        y: curY          }, thickness: 0.3, color: BORDER });
    cvPage.drawLine({ start: { x: X_PRC, y: curY - ROW_H }, end: { x: X_PRC,        y: curY          }, thickness: 0.3, color: BORDER });

    cvPage.drawText(trunc(item.reference, 18), { x: X_REF + 4, y: curY - ROW_H + 5, size: 8, font: fontReg, color: TXT });
    cvPage.drawText(trunc(item.title,     85), { x: X_OBJ + 4, y: curY - ROW_H + 5, size: 8, font: fontReg, color: TXT });
    const priceW = fontReg.widthOfTextAtSize(item.price, 8);
    cvPage.drawText(item.price, { x: X_PRC + COL_PRC - priceW - 4, y: curY - ROW_H + 5, size: 8, font: fontReg, color: TXT });

    curY -= ROW_H;
    rowAlt = !rowAlt;
  }

  // ── Helper: separator/cover page before each workflow's attachments ─────────
  function drawWorkflowSeparator(
    w: WfForPdf,
    position: number,
    hasAttachment: boolean,
    attachmentFilename: string,
  ) {
    const d = PORT;
    const sep = merged.addPage([d.pw, d.ph]);

    // ── Header band ──
    sep.drawRectangle({ x: 0, y: d.headerBot, width: d.pw, height: d.headerH, color: NAVY });
    sep.drawRectangle({ x: 0, y: d.headerBot, width: d.pw, height: 5, color: ACCENT });
    sep.drawRectangle({ x: d.pw - 10, y: d.headerBot, width: 10, height: d.headerH, color: NAVY_MID });
    sep.drawText(trunc(w.reference, 38), {
      x: ML, y: d.ph - 43, size: 20, font: fontBold, color: WHITE,
    });
    sep.drawText(trunc(`${w.departmentName}  ·  ${w.title}`, 72), {
      x: ML, y: d.ph - 66, size: 10, font: fontReg, color: HDR_SUB,
    });
    // Position badge (top-right of header)
    const badge = `Dossier ${position} / ${sorted.length}`;
    const badgeW = fontBold.widthOfTextAtSize(badge, 9);
    sep.drawText(badge, {
      x: d.pw - MR - 14 - badgeW, y: d.ph - 26, size: 9, font: fontBold, color: WHITE,
    });

    // ── Info band ──
    const infoY = d.headerBot - INFO_H;
    sep.drawRectangle({ x: 0, y: infoY, width: d.pw, height: INFO_H, color: INFO_BG });
    sep.drawLine({ start: { x: 0, y: infoY }, end: { x: d.pw, y: infoY }, thickness: 0.5, color: BORDER });
    sep.drawText("Récapitulatif du dossier", {
      x: ML, y: infoY + 8, size: 7.5, font: fontBold, color: NAVY_MID,
    });
    sep.drawText(`Réunion du ${meetingLabel}`, {
      x: d.pw - MR - fontReg.widthOfTextAtSize(`Réunion du ${meetingLabel}`, 7.5),
      y: infoY + 8, size: 7.5, font: fontReg, color: MUTED,
    });

    // ── Detail card ──
    const cardX = ML;
    const cardY = infoY - 200;
    const cardW = d.uw;
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
    sep.drawLine({ start: { x: ML, y: arrowY + 20 }, end: { x: d.pw - MR, y: arrowY + 20 }, thickness: 1, color: ACCENT });
    const arrow = hasAttachment ? "PIECE JOINTE CI-APRES  >>" : "AUCUNE PIECE JOINTE PDF POUR CE DOSSIER";
    const arrowW = fontBold.widthOfTextAtSize(arrow, 12);
    sep.drawText(arrow, {
      x: (d.pw - arrowW) / 2, y: arrowY, size: 12, font: fontBold,
      color: hasAttachment ? NAVY_MID : MUTED,
    });
    sep.drawLine({ start: { x: ML, y: arrowY - 8 }, end: { x: d.pw - MR, y: arrowY - 8 }, thickness: 1, color: ACCENT });
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
      const dp = PORT;
      const info = merged.addPage([dp.pw, dp.ph]);
      info.drawRectangle({ x: 0, y: dp.headerBot, width: dp.pw, height: dp.headerH, color: NAVY });
      info.drawRectangle({ x: 0, y: dp.headerBot, width: dp.pw, height: 5, color: ACCENT });
      info.drawRectangle({ x: dp.pw - 10, y: dp.headerBot, width: 10, height: dp.headerH, color: NAVY_MID });
      info.drawText(trunc(w.reference, 35), {
        x: ML, y: dp.ph - 43, size: 18, font: fontBold, color: WHITE,
      });
      info.drawText(trunc(`${w.departmentName} — ${w.title}`, 70), {
        x: ML, y: dp.ph - 66, size: 10, font: fontReg, color: HDR_SUB,
      });
      info.drawText(`Pièce jointe : ${winner.filename}`, {
        x: ML, y: dp.ph - 180, size: 11, font: fontReg, color: TXT,
      });
      info.drawText(`Type : ${winner.mimeType}`, {
        x: ML, y: dp.ph - 198, size: 9, font: fontReg, color: MUTED,
      });
      info.drawText("(Pièce non-PDF — impossible de l'incorporer dans le pack)", {
        x: ML, y: dp.ph - 216, size: 9, font: fontReg, color: MUTED,
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
