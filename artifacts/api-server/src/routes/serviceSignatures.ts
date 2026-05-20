import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  serviceSignaturesTable,
  usersTable,
  workflowsTable,
} from "@workspace/db";
import { requireAuth, getUser } from "../middlewares/auth";
import { canSeeWorkflow, hasRole } from "../lib/permissions";
import { getSettings } from "../lib/settings";
import {
  buildServiceAttestationPdf,
  listServiceSignatures,
  rememberSigNonce,
  consumeSigNonce,
} from "../lib/serviceSignatures";
import {
  prepareForSigning,
  embedSignature,
  createSignSession,
  consumeSignSession,
} from "../lib/pdfSign";
import { audit } from "../lib/audit";

const router: IRouter = Router();

router.get(
  "/workflows/:id/service-signatures",
  requireAuth,
  async (req, res): Promise<void> => {
    const wfId = Number(req.params.id);
    if (!Number.isFinite(wfId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [wf] = await db
      .select()
      .from(workflowsTable)
      .where(eq(workflowsTable.id, wfId));
    if (!wf) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!canSeeWorkflow(getUser(req), wf.departmentId)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const rows = await listServiceSignatures(wfId);
    // Resolve every notified email to a user displayName so the UI can
    // show the actual person(s) on the hook rather than a raw address.
    // Emails not matching any local user fall back to the email itself.
    const allEmails = Array.from(
      new Set(
        rows
          .flatMap((r) => r.notifiedEmails)
          .map((e) => e.toLowerCase())
          .filter((e) => e.length > 0),
      ),
    );
    const nameByEmail = new Map<string, string>();
    if (allEmails.length > 0) {
      const users = await db
        .select({ email: usersTable.email, displayName: usersTable.displayName })
        .from(usersTable);
      for (const u of users) {
        if (u.email) nameByEmail.set(u.email.toLowerCase(), u.displayName);
      }
    }
    const enriched = rows.map((r) => ({
      ...r,
      notifiedRecipients: r.notifiedEmails.map((email) => ({
        email,
        name: nameByEmail.get(email.toLowerCase()) ?? null,
      })),
    }));
    res.json(enriched);
  },
);

router.post(
  "/workflows/:id/service-signatures/:sigId/sign-prepare",
  requireAuth,
  async (req, res): Promise<void> => {
    const wfId = Number(req.params.id);
    const sigId = Number(req.params.sigId);
    if (!Number.isFinite(wfId) || !Number.isFinite(sigId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const user = getUser(req);
    const [wf] = await db
      .select()
      .from(workflowsTable)
      .where(eq(workflowsTable.id, wfId));
    if (!wf) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    if (!canSeeWorkflow(user, wf.departmentId)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const [sig] = await db
      .select()
      .from(serviceSignaturesTable)
      .where(
        and(
          eq(serviceSignaturesTable.id, sigId),
          eq(serviceSignaturesTable.workflowId, wfId),
        ),
      );
    if (!sig) {
      res.status(404).json({ error: "Signature row not found" });
      return;
    }
    if (sig.status !== "PENDING") {
      res.status(400).json({
        error: "Cette validation a deja ete signee ou contournee.",
      });
      return;
    }
    // Privileged users (Admin / Financial-All) can sign for any service;
    // otherwise the connected user's email must appear in the notified list.
    const isPrivileged = hasRole(user, "FINANCIAL_ALL", "ADMIN");
    const userEmail = (user.email ?? "").toLowerCase();
    const allowed =
      isPrivileged ||
      sig.notifiedEmails.map((e) => e.toLowerCase()).includes(userEmail);
    if (!allowed) {
      res
        .status(403)
        .json({ error: "Vous n'etes pas autorise(e) a signer pour ce service." });
      return;
    }

    const rawCertSubject = String(req.body?.certSubject ?? "").trim();
    const signerName =
      rawCertSubject || user.displayName || user.username || "Service";

    const pdfDoc = await buildServiceAttestationPdf({
      workflowReference: wf.reference,
      workflowTitle: wf.title,
      ruleLabel: sig.ruleLabel,
      signerName,
    });
    const prepared = await prepareForSigning(pdfDoc, {
      reason: sig.ruleLabel,
      name: signerName,
      location: wf.reference,
    });

    const nonce = createSignSession({
      kind: "service",
      workflowId: wf.id,
      userId: user.id,
      filename: `${wf.reference}-${sig.ruleKey}.pdf`,
      prepared,
    });
    rememberSigNonce(nonce, sig.id);

    res.json({
      nonce,
      signTargetB64: prepared.signTarget.toString("base64"),
    });
  },
);

const FinalizeBody = z.object({
  nonce: z.string().min(16),
  pkcs7B64: z.string().min(1),
  certSubject: z.string().optional(),
  certThumbprint: z.string().optional(),
});

router.post(
  "/workflows/:id/service-signatures/:sigId/sign-finalize",
  requireAuth,
  async (req, res): Promise<void> => {
    const body = FinalizeBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const wfId = Number(req.params.id);
    const sigId = Number(req.params.sigId);
    const user = getUser(req);
    const session = consumeSignSession(body.data.nonce, "service");
    if (!session) {
      res.status(410).json({
        error:
          "Session de signature inconnue ou expiree. Relancez la signature.",
      });
      return;
    }
    const recordedSigId = consumeSigNonce(body.data.nonce);
    if (
      session.workflowId !== wfId ||
      session.userId !== user.id ||
      recordedSigId !== sigId
    ) {
      res.status(403).json({ error: "Session de signature non autorisee." });
      return;
    }
    let pkcs7: Buffer;
    try {
      pkcs7 = Buffer.from(body.data.pkcs7B64, "base64");
    } catch {
      res.status(400).json({ error: "pkcs7B64 invalide." });
      return;
    }
    let signed: Buffer;
    try {
      signed = embedSignature(session.prepared, pkcs7);
    } catch (err) {
      res.status(500).json({ error: `Embed PKCS#7 echoue: ${String(err)}` });
      return;
    }

    await db
      .update(serviceSignaturesTable)
      .set({
        status: "SIGNED",
        signedByUserId: user.id,
        signedByName: user.displayName ?? user.username,
        signedAt: new Date(),
        certSubject: body.data.certSubject ?? null,
        certThumbprint: body.data.certThumbprint ?? null,
        signedPdfBase64: signed.toString("base64"),
      })
      .where(eq(serviceSignaturesTable.id, sigId));

    await audit(
      user.id,
      "SERVICE_SIGNATURE",
      "workflow",
      wfId,
      `service signature ${sigId} signed (${signed.length} bytes)`,
    );

    const [row] = await db
      .select()
      .from(serviceSignaturesTable)
      .where(eq(serviceSignaturesTable.id, sigId));
    res.json(row);
  },
);

// ─── Sign without certificate (cert signing disabled in settings) ─────────────
//
// When the admin disables the Windows certificate signing agent in
// Paramètres, the cert-based flow is replaced by a simple "Valider"
// click. We still record who validated and when, so the audit trail
// looks identical to a cert-signed row (minus the PKCS#7 PDF).
router.post(
  "/workflows/:id/service-signatures/:sigId/sign-no-cert",
  requireAuth,
  async (req, res): Promise<void> => {
    const wfId = Number(req.params.id);
    const sigId = Number(req.params.sigId);
    const user = getUser(req);
    // Refuse if the admin has not actually disabled the cert flow —
    // otherwise users could skip the Windows agent signature at will.
    const settings = await getSettings();
    if (settings.certSigningEnabled) {
      res.status(400).json({
        error:
          "La signature par certificat est activée — utilisez l'agent de signature Windows.",
      });
      return;
    }
    const [sig] = await db
      .select()
      .from(serviceSignaturesTable)
      .where(
        and(
          eq(serviceSignaturesTable.id, sigId),
          eq(serviceSignaturesTable.workflowId, wfId),
        ),
      );
    if (!sig) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (sig.status !== "PENDING") {
      res.status(400).json({ error: "Deja traitee" });
      return;
    }
    // Eligibility mirrors the client `canSign` rule: either the user is
    // ADMIN / FINANCIAL_ALL, or their email is in the notifiedEmails list
    // for this signature.
    const privileged =
      hasRole(user, "ADMIN", "FINANCIAL_ALL") ||
      sig.notifiedEmails
        .map((e) => e.toLowerCase())
        .includes((user.email ?? "").toLowerCase());
    if (!privileged) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    await db
      .update(serviceSignaturesTable)
      .set({
        status: "SIGNED",
        signedByUserId: user.id,
        signedByName: user.displayName ?? user.email ?? "—",
        signedAt: new Date(),
        certSubject: null,
      })
      .where(eq(serviceSignaturesTable.id, sigId));
    await audit(
      user.id,
      "SERVICE_SIGNATURE_SIGN_NO_CERT",
      "workflow",
      wfId,
      `sig ${sigId}`,
    );
    const [row] = await db
      .select()
      .from(serviceSignaturesTable)
      .where(eq(serviceSignaturesTable.id, sigId));
    res.json(row);
  },
);

const OverrideBody = z.object({ reason: z.string().min(3) });

router.post(
  "/workflows/:id/service-signatures/:sigId/override",
  requireAuth,
  async (req, res): Promise<void> => {
    const body = OverrideBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const wfId = Number(req.params.id);
    const sigId = Number(req.params.sigId);
    const user = getUser(req);
    if (!hasRole(user, "ADMIN", "FINANCIAL_ALL")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const [sig] = await db
      .select()
      .from(serviceSignaturesTable)
      .where(
        and(
          eq(serviceSignaturesTable.id, sigId),
          eq(serviceSignaturesTable.workflowId, wfId),
        ),
      );
    if (!sig) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (sig.status !== "PENDING") {
      res.status(400).json({ error: "Deja traitee" });
      return;
    }
    await db
      .update(serviceSignaturesTable)
      .set({
        status: "OVERRIDDEN",
        overrideByUserId: user.id,
        overrideReason: body.data.reason,
        signedAt: new Date(),
      })
      .where(eq(serviceSignaturesTable.id, sigId));
    await audit(
      user.id,
      "SERVICE_SIGNATURE_OVERRIDE",
      "workflow",
      wfId,
      `sig ${sigId}: ${body.data.reason}`,
    );
    const [row] = await db
      .select()
      .from(serviceSignaturesTable)
      .where(eq(serviceSignaturesTable.id, sigId));
    res.json(row);
  },
);

export default router;
