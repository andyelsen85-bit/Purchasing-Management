import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { findByteRange } from "@signpdf/utils";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import crypto from "node:crypto";

// 16 KB hex-padding window for the PKCS#7 SignedData blob. A typical
// SignedCms with WholeChain include sits well below 8 KB, so 16 KB is
// generous headroom — and consistent with the @signpdf default sizing.
const PLACEHOLDER_HEX_BYTES = 16384;

export interface PreparedSign {
  preparedBytes: Buffer;
  signTarget: Buffer;
  placeholderStart: number; // offset of '<' in Contents <00...00>
  placeholderEnd: number; // offset of '>'
  placeholderHexLength: number; // count of hex chars between '<' and '>'
}

export interface PrepareOptions {
  reason?: string;
  name?: string;
  location?: string;
  contactInfo?: string;
}

// ---------------------------------------------------------------------------
// Visual signature block — drawn directly into the page content stream so it
// is covered by the signed ByteRange and cannot be altered after signing.
// Placed in the bottom-right corner of the last page.
// ---------------------------------------------------------------------------
async function drawSignatureVisual(
  pdfDoc: PDFDocument,
  opts: PrepareOptions,
): Promise<void> {
  const firstPage = pdfDoc.getPage(0);
  const { width, height } = firstPage.getSize();

  const BOX_W = 210;
  const BOX_H = 78;
  const MARGIN = 14;
  const x = width - BOX_W - MARGIN;
  const y = height - BOX_H - MARGIN;

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const now = new Date();
  const dateStr = now.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Header band
  firstPage.drawRectangle({
    x,
    y: y + BOX_H - 17,
    width: BOX_W,
    height: 17,
    color: rgb(0.13, 0.22, 0.55),
  });

  // Body background
  firstPage.drawRectangle({
    x,
    y,
    width: BOX_W,
    height: BOX_H - 17,
    color: rgb(0.94, 0.95, 0.99),
    borderColor: rgb(0.13, 0.22, 0.55),
    borderWidth: 1,
  });

  // Header text
  firstPage.drawText("SIGNATURE ELECTRONIQUE", {
    x: x + 6,
    y: y + BOX_H - 12,
    size: 7,
    font: fontBold,
    color: rgb(1, 1, 1),
  });

  // Body lines
  const lines: [string, string][] = [
    ["Par", (opts.name ?? "").slice(0, 34)],
    ["Motif", (opts.reason ?? "").slice(0, 34)],
    ["Lieu", (opts.location ?? "").slice(0, 34)],
    ["Date", dateStr],
  ];

  let lineY = y + BOX_H - 29;
  for (const [label, value] of lines) {
    firstPage.drawText(`${label} :`, {
      x: x + 6,
      y: lineY,
      size: 7,
      font: fontBold,
      color: rgb(0.13, 0.22, 0.55),
    });
    firstPage.drawText(value, {
      x: x + 36,
      y: lineY,
      size: 7,
      font,
      color: rgb(0, 0, 0),
    });
    lineY -= 11;
  }
}

/**
 * Add a PAdES signature placeholder to a PDF and return both the prepared
 * bytes (with /ByteRange already patched to the real offsets) and the
 * `signTarget` — the bytes covered by ByteRange that the external signer
 * must hash and sign with PKCS#7 SignedData (detached).
 *
 * A visible signature block is drawn on the last page **before** the crypto
 * placeholder is inserted so it falls inside the signed byte ranges and
 * cannot be altered post-signing.
 *
 * The PDF length is preserved from the placeholder add through the final
 * `embedSignature` call, so the byte offsets baked into /ByteRange remain
 * valid all the way through. `embedSignature` is the inverse: it writes
 * the PKCS#7 hex into the Contents <…> placeholder.
 */
export async function prepareForSigning(
  pdfDoc: PDFDocument,
  opts: PrepareOptions = {},
): Promise<PreparedSign> {
  // Draw the visible signature block first — it must be inside the signed
  // byte ranges so it is tamper-evident.
  await drawSignatureVisual(pdfDoc, opts);

  pdflibAddPlaceholder({
    pdfDoc,
    reason: opts.reason ?? "Validation facture",
    contactInfo: opts.contactInfo ?? "",
    name: opts.name ?? "Purchasing Management",
    location: opts.location ?? "",
    signatureLength: PLACEHOLDER_HEX_BYTES,
  });

  // useObjectStreams: false writes a traditional xref table so that
  // findByteRange can locate the ByteRange placeholder reliably.
  const savedBytes = Buffer.from(
    await pdfDoc.save({ useObjectStreams: false }),
  );

  const { byteRangePlaceholder, byteRangePlaceholderPosition } =
    findByteRange(savedBytes);
  if (!byteRangePlaceholder || byteRangePlaceholderPosition == null) {
    throw new Error("ByteRange placeholder not found in prepared PDF");
  }

  const byteRangeEnd =
    byteRangePlaceholderPosition + byteRangePlaceholder.length;

  // Search for the exact "/Contents <" byte sequence so we land on the
  // Contents hex string and not on a stray dictionary "<<" bracket that
  // also contains 0x3C.  pdflibAddPlaceholder always writes this exact key.
  const CONTENTS_TAG = Buffer.from("/Contents <", "latin1");
  const contentsTagIdx = savedBytes.indexOf(CONTENTS_TAG);
  if (contentsTagIdx === -1) {
    throw new Error("'/Contents <' tag not found in prepared PDF");
  }
  // placeholderStart points at the '<' that opens the hex string
  const placeholderStart = contentsTagIdx + CONTENTS_TAG.length - 1;
  const placeholderEnd = savedBytes.indexOf(0x3e /* '>' */, placeholderStart + 1);
  if (placeholderEnd === -1) {
    throw new Error("Contents placeholder closing '>' not found in prepared PDF");
  }

  const byteRange = [
    0,
    placeholderStart,
    placeholderEnd + 1,
    savedBytes.length - (placeholderEnd + 1),
  ];
  let actualByteRange = `/ByteRange [${byteRange.join(" ")}]`;
  if (actualByteRange.length > byteRangePlaceholder.length) {
    throw new Error("Patched ByteRange longer than placeholder slot");
  }
  actualByteRange = actualByteRange.padEnd(
    byteRangePlaceholder.length,
    " ",
  );

  const patched = Buffer.concat([
    savedBytes.subarray(0, byteRangePlaceholderPosition),
    Buffer.from(actualByteRange, "latin1"),
    savedBytes.subarray(byteRangeEnd),
  ]);

  const signTarget = Buffer.concat([
    patched.subarray(0, byteRange[1]),
    patched.subarray(byteRange[2]),
  ]);

  return {
    preparedBytes: patched,
    signTarget,
    placeholderStart,
    placeholderEnd,
    placeholderHexLength: placeholderEnd - placeholderStart - 1,
  };
}

/**
 * Splice the PKCS#7 SignedData blob (binary) into the Contents <…> slot
 * of the prepared PDF, hex-encoded and right-padded with '0' to fit.
 */
export function embedSignature(
  prepared: PreparedSign,
  pkcs7: Buffer,
): Buffer {
  const hex = pkcs7.toString("hex");
  if (hex.length > prepared.placeholderHexLength) {
    throw new Error(
      `PKCS#7 too large: ${hex.length} hex chars vs ${prepared.placeholderHexLength} reserved.`,
    );
  }
  const padded = hex.padEnd(prepared.placeholderHexLength, "0");
  return Buffer.concat([
    prepared.preparedBytes.subarray(0, prepared.placeholderStart + 1),
    Buffer.from(padded, "latin1"),
    prepared.preparedBytes.subarray(prepared.placeholderEnd),
  ]);
}

// ---------------------------------------------------------------------------
// In-memory pending signing sessions. Each `sign-prepare` call stores the
// prepared PDF here keyed by an opaque nonce; `sign-finalize` consumes it.
// We keep this in process memory because the pack PDFs can be several MB
// and re-running the merge on finalize would double the work, while the
// browser round-trip to the local agent typically completes in <2s.
// ---------------------------------------------------------------------------

interface PendingSession {
  workflowId: number;
  userId: number;
  filename: string;
  prepared: PreparedSign;
  createdAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const pending = new Map<string, PendingSession>();

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of pending.entries()) {
    if (now - v.createdAt > TTL_MS) pending.delete(k);
  }
}

export function createSignSession(
  s: Omit<PendingSession, "createdAt">,
): string {
  sweep();
  const nonce = crypto.randomBytes(24).toString("hex");
  pending.set(nonce, { ...s, createdAt: Date.now() });
  return nonce;
}

export function consumeSignSession(nonce: string): PendingSession | null {
  sweep();
  const s = pending.get(nonce);
  if (!s) return null;
  pending.delete(nonce);
  return s;
}
