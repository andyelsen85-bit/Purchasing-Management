import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { findByteRange } from "@signpdf/utils";
import type { PDFDocument } from "pdf-lib";
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

/**
 * Add a PAdES signature placeholder to a PDF and return both the prepared
 * bytes (with /ByteRange already patched to the real offsets) and the
 * `signTarget` — the bytes covered by ByteRange that the external signer
 * must hash and sign with PKCS#7 SignedData (detached).
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

  // Search for the Contents <00…00> hex string that follows ByteRange.
  const placeholderStart = savedBytes.indexOf(0x3c /* '<' */, byteRangeEnd);
  const placeholderEnd = savedBytes.indexOf(0x3e /* '>' */, placeholderStart);
  if (placeholderStart === -1 || placeholderEnd === -1) {
    throw new Error("Contents placeholder not found in prepared PDF");
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
