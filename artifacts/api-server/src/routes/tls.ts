import { Router, type IRouter } from "express";
import forge from "node-forge";
import { db, tlsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { GenerateCsrBody, ImportCertBody } from "@workspace/api-zod";
import { requireAuth, requireRole, getUser } from "../middlewares/auth";
import { audit } from "../lib/audit";

const router: IRouter = Router();

async function getOrCreateState() {
  const [row] = await db.select().from(tlsTable).limit(1);
  if (row) return row;
  const [created] = await db.insert(tlsTable).values({}).returning();
  return created!;
}

router.get(
  "/admin/cert",
  requireAuth,
  requireRole("ADMIN"),
  async (_req, res): Promise<void> => {
    const state = await getOrCreateState();
    if (!state.certPem) {
      res.json({
        present: false,
        subject: null,
        issuer: null,
        validFrom: null,
        validTo: null,
        sans: [],
        fingerprint: null,
      });
      return;
    }
    const cert = forge.pki.certificateFromPem(state.certPem);
    const sans: string[] = [];
    const sanExt = cert.getExtension("subjectAltName") as
      | { altNames?: Array<{ value?: string }> }
      | undefined;
    if (sanExt?.altNames) for (const n of sanExt.altNames) if (n.value) sans.push(n.value);
    const md = forge.md.sha256.create();
    md.update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
    res.json({
      present: true,
      subject: cert.subject.attributes.map((a) => `${a.shortName}=${a.value}`).join(", "),
      issuer: cert.issuer.attributes.map((a) => `${a.shortName}=${a.value}`).join(", "),
      validFrom: cert.validity.notBefore,
      validTo: cert.validity.notAfter,
      sans,
      fingerprint: md.digest().toHex(),
    });
  },
);

router.post(
  "/admin/csr",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const parsed = GenerateCsrBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;
    const subject = [
      { name: "commonName", value: parsed.data.commonName },
      ...(parsed.data.organization
        ? [{ name: "organizationName", value: parsed.data.organization }]
        : []),
      ...(parsed.data.organizationalUnit
        ? [{ name: "organizationalUnitName", value: parsed.data.organizationalUnit }]
        : []),
      ...(parsed.data.country
        ? [{ name: "countryName", value: parsed.data.country }]
        : []),
      ...(parsed.data.state
        ? [{ shortName: "ST", value: parsed.data.state }]
        : []),
      ...(parsed.data.locality
        ? [{ name: "localityName", value: parsed.data.locality }]
        : []),
    ];
    csr.setSubject(subject);
    if (parsed.data.sans?.length) {
      csr.setAttributes([
        {
          name: "extensionRequest",
          extensions: [
            {
              name: "subjectAltName",
              altNames: parsed.data.sans.map((s) => ({ type: 2, value: s })),
            },
          ],
        },
      ]);
    }
    csr.sign(keys.privateKey, forge.md.sha256.create());
    const csrPem = forge.pki.certificationRequestToPem(csr);
    const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);

    const state = await getOrCreateState();
    await db
      .update(tlsTable)
      .set({ csrPem, privateKeyPem })
      .where(eq(tlsTable.id, state.id));
    await audit(getUser(req).id, "CSR_GENERATE", "tls");
    res.status(201).json({ csrPem });
  },
);

router.post(
  "/admin/cert",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const parsed = ImportCertBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const cert = forge.pki.certificateFromPem(parsed.data.certPem);
    const state = await getOrCreateState();
    await db
      .update(tlsTable)
      .set({
        certPem: parsed.data.certPem,
        chainPem: parsed.data.chainPem ?? null,
      })
      .where(eq(tlsTable.id, state.id));
    const sans: string[] = [];
    const sanExt = cert.getExtension("subjectAltName") as
      | { altNames?: Array<{ value?: string }> }
      | undefined;
    if (sanExt?.altNames) for (const n of sanExt.altNames) if (n.value) sans.push(n.value);
    const md = forge.md.sha256.create();
    md.update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
    await audit(getUser(req).id, "CERT_IMPORT", "tls");
    res.status(201).json({
      present: true,
      subject: cert.subject.attributes.map((a) => `${a.shortName}=${a.value}`).join(", "),
      issuer: cert.issuer.attributes.map((a) => `${a.shortName}=${a.value}`).join(", "),
      validFrom: cert.validity.notBefore,
      validTo: cert.validity.notAfter,
      sans,
      fingerprint: md.digest().toHex(),
    });
  },
);

export default router;
