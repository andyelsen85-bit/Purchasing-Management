import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { eq } from "drizzle-orm";
import {
  db,
  serviceSignaturesTable,
  notificationRulesTable,
} from "@workspace/db";

export interface RequiredRule {
  key: string;
  label: string;
}

const RULE_DEFS: Array<{
  key: string;
  label: string;
  triggered: (f: Record<string, unknown>) => boolean;
}> = [
  {
    // Merged legal rule — Q4.1.1, Q4.1.3, Q7.1 (data types) and Q7.3
    // (AI) all route to the same Service juridique. We fire on any of
    // these signals so legal sees a single attestation to sign instead
    // of several.
    // - Q4.1.1 (LIVRE_I tier) triggers on "Oui" or "Je ne sais pas"
    // - Q4.1.3 (LIVRE_II tier) triggers on *any* answer (Oui / Non / JNS)
    // - Q7.1 triggers when at least one *sensitive* data type is
    //   selected (PHI, PII, données critiques, autres données du CHdN).
    //   The "Aucunes données" choice is mutually exclusive with the
    //   others and does NOT trigger legal.
    // - Q7.3 triggers on "Oui" (hasAI === true)
    key: "q_legal",
    label: "Service juridique (4.1.1 / 4.1.3 / 7.1 / 7.3)",
    triggered: (f) => {
      const livreI = f.livreIAnswer;
      if (livreI === "true" || livreI === "unknown") return true;
      const livreII = f.livreIIAnswer;
      if (livreII === "true" || livreII === "false" || livreII === "unknown")
        return true;
      if (f.hasAI === true) return true;
      const dataTypes = f.dataTypes;
      if (
        Array.isArray(dataTypes) &&
        dataTypes.some(
          (d) => typeof d === "string" && d !== "Aucunes données",
        )
      ) {
        return true;
      }
      // Backward compat with workflows created before the raw-answer
      // fields were introduced: fall back to the stored procedure tier.
      if (f.exceptionProcedure === "LIVRE_I") return true;
      if (f.exceptionProcedure === "LIVRE_II") return true;
      return false;
    },
  },
  {
    key: "q_6_1",
    label: "Service Technique - Travaux architecturaux (6.1)",
    triggered: (f) => f.architecturalWorks === true,
  },
  {
    // Merged rule — Service Informatique is notified when either
    // Q6.2 (Connexion informatique requise) is answered "Oui", or
    // Q6.3.1 (Type d'accès) has at least one access type selected
    // (which only renders when Q6.3 systemInterop is "Oui"). One
    // attestation covers both questions for the same service.
    key: "q_6_3_1_it",
    label: "Service Informatique - Raccordement IT & Accès systèmes (6.2 / 6.3.1)",
    triggered: (f) => {
      if (f.itConnection === true) return true;
      // Q6.3.1 only renders when Q6.3 systemInterop is "Oui", so guard the
      // accessTypes branch with systemInterop to avoid false positives from
      // stale state if the user toggled Q6.3 back to "Non" after picking
      // access types.
      const access = f.accessTypes;
      if (
        f.systemInterop === true &&
        Array.isArray(access) &&
        access.length > 0
      ) {
        return true;
      }
      return false;
    },
  },
  {
    key: "q_6_3_1_security",
    label: "Service Securite - Interoperabilite (6.3.1)",
    triggered: (f) => f.systemInterop === true,
  },
  {
    key: "q_8_3",
    label: "Service Protection & Prevention - Consommables dangereux (8.3)",
    triggered: (f) => f.hazardousConsumables === true,
  },
  {
    key: "q_9_4",
    label: "Service SPCI - Nettoyage (9.4)",
    triggered: (f) => f.cleaningRequired === true,
  },
  {
    key: "q_9_5",
    label: "Service Sterilisation (9.5)",
    triggered: (f) => f.sterilizationRequired === true,
  },
];

export function requiredServiceRules(investmentForm: unknown): RequiredRule[] {
  const f = (investmentForm ?? {}) as Record<string, unknown>;
  return RULE_DEFS.filter((r) => r.triggered(f)).map(({ key, label }) => ({
    key,
    label,
  }));
}

/**
 * Seed service_signatures rows when a workflow enters VALIDATING_SERVICES.
 * Idempotent — rows already present for the same (workflow, rule_key) are
 * left untouched. Returns the (rule, emails) pairs so the caller can
 * dispatch one notification email per service.
 */
export async function seedServiceSignatures(wf: {
  id: number;
  investmentForm: unknown;
}): Promise<Array<{ key: string; label: string; emails: string[] }>> {
  const required = requiredServiceRules(wf.investmentForm);
  if (required.length === 0) return [];

  const rules = await db.select().from(notificationRulesTable);
  const byKey = new Map(rules.map((r) => [r.key, r] as const));

  const existing = await db
    .select({ ruleKey: serviceSignaturesTable.ruleKey })
    .from(serviceSignaturesTable)
    .where(eq(serviceSignaturesTable.workflowId, wf.id));
  const have = new Set(existing.map((r) => r.ruleKey));

  const out: Array<{ key: string; label: string; emails: string[] }> = [];
  for (const r of required) {
    const rule = byKey.get(r.key);
    const emails = (rule?.emails ?? []) as string[];
    if (!have.has(r.key)) {
      await db.insert(serviceSignaturesTable).values({
        workflowId: wf.id,
        ruleKey: r.key,
        ruleLabel: r.label,
        notifiedEmails: emails,
      });
    }
    out.push({ key: r.key, label: r.label, emails });
  }
  return out;
}

/**
 * Build the 1-page attestation PDF that the service representative signs.
 * Mirrors the look of the workflow pack cover (CHdN navy header) but
 * focused on a single service decision.
 */
export async function buildServiceAttestationPdf(args: {
  workflowReference: string;
  workflowTitle: string;
  ruleLabel: string;
  signerName: string;
}): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const PW = 595.28;
  const PH = 841.89;
  const page = doc.addPage([PW, PH]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const NAVY = rgb(0.0, 0.22, 0.44);
  const NAVY_MID = rgb(0.0, 0.37, 0.65);
  const TXT = rgb(0.12, 0.12, 0.12);
  const MUTED = rgb(0.44, 0.44, 0.44);
  const WHITE = rgb(1, 1, 1);
  const HDR_SUB = rgb(0.7, 0.86, 0.95);

  const safe = (s: string) => s.replace(/[^\x20-\x7E]/g, "?");

  page.drawRectangle({ x: 0, y: PH - 80, width: PW, height: 80, color: NAVY });
  page.drawText("ATTESTATION DE VALIDATION SERVICE", {
    x: 40,
    y: PH - 45,
    size: 18,
    font: bold,
    color: WHITE,
  });
  page.drawText("Purchasing Management", {
    x: 40,
    y: PH - 65,
    size: 9,
    font,
    color: HDR_SUB,
  });

  let y = PH - 130;
  const line = (label: string, value: string) => {
    page.drawText(label, { x: 40, y, size: 10, font: bold, color: NAVY_MID });
    page.drawText(safe(value), { x: 180, y, size: 10, font, color: TXT });
    y -= 22;
  };

  line("Dossier :", args.workflowReference);
  line("Objet :", args.workflowTitle.slice(0, 80));
  line("Service :", args.ruleLabel);
  line("Valide par :", args.signerName);
  line(
    "Date :",
    new Date().toLocaleString("fr-FR", {
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
  );

  y -= 16;
  page.drawText(
    safe(
      "Je, soussigne(e), atteste de la validation pour le service concerne ci-dessus.",
    ),
    { x: 40, y, size: 9, font, color: TXT, maxWidth: PW - 80 },
  );

  page.drawText(
    safe(
      "La signature electronique apposee sur ce document est juridiquement opposable.",
    ),
    { x: 40, y: 40, size: 7, font, color: MUTED },
  );

  return doc;
}

export async function listServiceSignatures(workflowId: number) {
  return db
    .select()
    .from(serviceSignaturesTable)
    .where(eq(serviceSignaturesTable.workflowId, workflowId))
    .orderBy(serviceSignaturesTable.id);
}

/**
 * Compute completion state for the VALIDATING_SERVICES gate.
 * A workflow can only leave VALIDATING_SERVICES when every signature row is
 * either SIGNED or OVERRIDDEN. If there are no rows at all (no triggering
 * answer on the form) the step can be advanced freely.
 */
export async function serviceSignaturesStatus(
  workflowId: number,
): Promise<{ total: number; done: number; pendingLabels: string[] }> {
  const rows = await listServiceSignatures(workflowId);
  const pending = rows.filter((r) => r.status === "PENDING");
  return {
    total: rows.length,
    done: rows.length - pending.length,
    pendingLabels: pending.map((r) => r.ruleLabel),
  };
}

/**
 * Map (sign session nonce) → (service_signatures.id). Lives in process
 * memory next to the pdfSign session cache so a finalize call can
 * identify which sig row to update.
 */
const nonceToSigId = new Map<string, number>();
export function rememberSigNonce(nonce: string, sigId: number): void {
  nonceToSigId.set(nonce, sigId);
}
export function consumeSigNonce(nonce: string): number | undefined {
  const v = nonceToSigId.get(nonce);
  if (v !== undefined) nonceToSigId.delete(nonce);
  return v;
}
