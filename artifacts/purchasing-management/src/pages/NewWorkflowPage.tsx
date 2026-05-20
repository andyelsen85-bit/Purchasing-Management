import { useState, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, ArrowRight, Loader2, ClipboardList, Upload, FileText, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useCreateWorkflow,
  useListDepartments,
  useListCompanies,
  useGetCompany,
  useGetSettings,
  useUpdateWorkflow,
  useGetWorkflow,
  useAdvanceWorkflow,
  useListWorkflowDocuments,
  Priority,
  type InvestmentForm,
  type Workflow,
} from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { extractApiError } from "@/lib/api-error";

const TOTAL_STEPS = 7;

const STEP_LABELS = [
  "Identification",
  "Description du besoin",
  "Nature & Financiers",
  "Fournisseur & Technique",
  "Données & Consommables",
  "Maintenance & Formation",
  "Documents à joindre",
];

const INVESTMENT_TYPES = [
  "Équipement médical",
  "Dispositif médical connecté",
  "Dispositif médical distribué au patient",
  "Équipement non médical",
  "Logiciel / IT",
  "Hardware IT",
  "Infrastructure / bâtiment",
  "Service de consultation ou de maintenance",
  "Stockage de données externe",
  "Autre",
];

const ACCESS_TYPES = [
  "Accès direct",
  "API / Intégrations",
  "Accès à distance",
  "Accès limité à une application spécifique",
  "Je ne sais pas",
];

const DATA_TYPES = [
  "Données de santé (PHI)",
  "Données personnelles (PII)",
  "Données critiques (financières, IT, etc.)",
  "Autres données du CHdN",
];

const CE_CERT_LABEL = "Certificat CE (obligatoire si équipement médical ou hardware)";
const DECLARATION_CONFORMITE_LABEL = "Déclaration de conformité";

const REQUIRED_DOCS = [
  "Offre de prix",
  "Offre de prix des consommables",
  "Offre de prix pour formation",
  "Offre de prix pour la maintenance",
  "Documentation contractuelle (SLA, CGV, maintenance, etc.)",
  "Fiche technique",
  "Manuel d'utilisation",
  CE_CERT_LABEL,
  DECLARATION_CONFORMITE_LABEL,
  "Certificat de résistance au feu (si mobilier ou matériel inflammable)",
  "Normes ISO 80601 et/ou IEC 60601 (pour matériel roulant)",
];

// Map a section-11 doc label to the document `kind` stored in the
// workflow documents collection. The first one ("Offre de prix") is
// the first quote of the workflow, so it gets QUOTE — every other
// document is filed as OTHER on the QUOTATION step.
function docKindFor(label: string): "QUOTE" | "OTHER" {
  return label === "Offre de prix" ? "QUOTE" : "OTHER";
}

function SectionTitle({ number, label }: { number: string; label: string }) {
  return (
    <div className="flex items-center gap-2 border-b pb-2 mb-4">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
        {number}
      </span>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h3>
    </div>
  );
}

function YesNoSelect({
  value,
  onChange,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  testId?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger data-testid={testId}>
        <SelectValue placeholder="Sélectionner..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="true">Oui</SelectItem>
        <SelectItem value="false">Non</SelectItem>
      </SelectContent>
    </Select>
  );
}

function YesNoMaybeSelect({
  value,
  onChange,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  testId?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger data-testid={testId}>
        <SelectValue placeholder="Sélectionner..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="true">Oui</SelectItem>
        <SelectItem value="false">Non</SelectItem>
        <SelectItem value="unknown">Je ne sais pas</SelectItem>
      </SelectContent>
    </Select>
  );
}

function CheckboxList({
  options,
  values,
  onChange,
  optionLabels,
  disabledOptions,
}: {
  options: string[];
  values: string[];
  onChange: (v: string[]) => void;
  optionLabels?: Record<string, React.ReactNode>;
  // Options that must stay checked (mandatory) — the checkbox is
  // rendered disabled so the user cannot uncheck the row.
  disabledOptions?: string[];
}) {
  function toggle(opt: string) {
    if (disabledOptions?.includes(opt)) return;
    if (values.includes(opt)) onChange(values.filter((v) => v !== opt));
    else onChange([...values, opt]);
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((opt) => {
        const isDisabled = disabledOptions?.includes(opt) ?? false;
        return (
          <div key={opt} className="flex items-start space-x-2">
            <Checkbox
              id={`cb-${opt}`}
              checked={values.includes(opt)}
              disabled={isDisabled}
              onCheckedChange={() => toggle(opt)}
            />
            <Label
              htmlFor={`cb-${opt}`}
              className={`font-normal leading-snug ${isDisabled ? "cursor-not-allowed opacity-90" : "cursor-pointer"}`}
            >
              {optionLabels?.[opt] ?? opt}
              {isDisabled && (
                <span className="ml-1 text-[10px] uppercase tracking-wide text-primary">
                  · obligatoire
                </span>
              )}
            </Label>
          </div>
        );
      })}
    </div>
  );
}

// Required-field marker.
function Req() {
  return <span className="text-destructive ml-0.5">*</span>;
}

export function NewWorkflowPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { data: departments } = useListDepartments();
  const { data: companies } = useListCompanies();
  const { data: settings } = useGetSettings();
  const { toast } = useToast();

  const [step, setStep] = useState(1);
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // If the URL carries ?draftId=<n> we're resuming a server-side draft.
  // The full workflow record is fetched and used to hydrate the form
  // below; saving re-PATCHes the same row instead of creating a new one.
  const draftId = (() => {
    if (typeof window === "undefined") return null;
    const v = new URLSearchParams(window.location.search).get("draftId");
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const draftQuery = useGetWorkflow(draftId ?? 0, {
    query: {
      enabled: draftId != null,
      queryKey: ["draft-workflow", draftId] as const,
    },
  });
  // Documents already uploaded with this draft (if any).
  const draftDocsQuery = useListWorkflowDocuments(draftId ?? 0, {
    query: {
      enabled: draftId != null,
      queryKey: ["draft-workflow-documents", draftId] as const,
    },
  });
  const advance = useAdvanceWorkflow();
  const [hydratedFromDraft, setHydratedFromDraft] = useState(false);

  // ── Basic workflow fields ──────────────────────────────────────
  const [title, setTitle] = useState("");
  const [departmentId, setDepartmentId] = useState<string>("");
  const [priority, setPriority] = useState<keyof typeof Priority>("NORMAL");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");

  // ── Section 1 – Identification ─────────────────────────────────
  const [projectLeader, setProjectLeader] = useState("");
  const [investmentTypes, setInvestmentTypes] = useState<string[]>([]);
  const [investmentTypeOther, setInvestmentTypeOther] = useState("");

  // ── Section 2 – Description du besoin ─────────────────────────
  const [justification, setJustification] = useState("");
  const [demoTested, setDemoTested] = useState("");
  const [demoContext, setDemoContext] = useState("");

  // ── Section 3 – Nature de la demande ──────────────────────────
  const [requestNature, setRequestNature] = useState("");
  const [replacedEquipmentRef, setReplacedEquipmentRef] = useState("");
  const [replacedEquipmentLocation, setReplacedEquipmentLocation] = useState("");
  const [replacementReason, setReplacementReason] = useState("");
  const [decommissioned, setDecommissioned] = useState("");
  const [decommissionedNote, setDecommissionedNote] = useState("");

  // ── Section 4 – Aspects financiers ────────────────────────────
  const [estimatedAmount5y, setEstimatedAmount5y] = useState("");
  // Q4.1.1 — exception Livre I? (shown when amount is between X and Y)
  const [livreIException, setLivreIException] = useState("");
  // Q4.1.2 — justification Livre I (shown when 4.1.1 = Oui)
  // Q4.1.4 — justification Livre II (shown when 4.1.3 = Oui)
  // Reuse the same field since the two tiers are mutually exclusive.
  const [exceptionJustification, setExceptionJustification] = useState("");
  // Q4.1.3 — exception Livre II? (shown when amount > Y)
  const [livreIIException, setLivreIIException] = useState("");
  const [budgetPositionKnown, setBudgetPositionKnown] = useState("");
  const [budgetPosition, setBudgetPosition] = useState("");

  // Derive the publication tier from the 5-year amount and the configured
  // thresholds. Two bands: between X and Y, or above Y.
  const limitX = settings?.limitX ?? null;
  const limitY = settings?.quoteThresholdLivreI ?? null;
  const amount5yNum = estimatedAmount5y ? Number(estimatedAmount5y) : null;
  const tier: "STANDARD" | "BAND_XY" | "ABOVE_Y" =
    amount5yNum == null
      ? "STANDARD"
      : limitY != null && amount5yNum > limitY
        ? "ABOVE_Y"
        : limitX != null && amount5yNum > limitX
          ? "BAND_XY"
          : "STANDARD";

  // ── Section 5 – Fournisseur ────────────────────────────────────
  const [supplierCompanyId, setSupplierCompanyId] = useState<string>("");
  const [supplierContactId, setSupplierContactId] = useState<string>("");
  const [supplierFreeTextName, setSupplierFreeTextName] = useState("");
  const [supplierFreeTextContact, setSupplierFreeTextContact] = useState("");

  // ── Section 6 – Aspects techniques ────────────────────────────
  const [architecturalWorks, setArchitecturalWorks] = useState("");
  const [itConnection, setItConnection] = useState("");
  const [systemInterop, setSystemInterop] = useState("");
  const [accessTypes, setAccessTypes] = useState<string[]>([]);

  // ── Section 7 – Données & Sécurité ────────────────────────────
  const [dataTypes, setDataTypes] = useState<string[]>([]);
  const [availabilityImpact, setAvailabilityImpact] = useState("");
  const [hasAI, setHasAI] = useState("");

  // ── Section 8 – Consommables ──────────────────────────────────
  const [consumablesNeeded, setConsumablesNeeded] = useState("");
  const [consumablesOfferAttached, setConsumablesOfferAttached] = useState("");
  const [hazardousConsumables, setHazardousConsumables] = useState("");

  // ── Section 9 – Maintenance ───────────────────────────────────
  const [warrantyDuration, setWarrantyDuration] = useState("");
  const [maintenanceContract, setMaintenanceContract] = useState("");
  const [cleaningRequired, setCleaningRequired] = useState("");
  const [sterilizationRequired, setSterilizationRequired] = useState("");

  // ── Section 10 – Formation & Mise en service ──────────────────
  const [trainingRequired, setTrainingRequired] = useState("");
  const [trainingOfferAttached, setTrainingOfferAttached] = useState("");
  const [commissioningDate, setCommissioningDate] = useState("");

  // ── Section 11 – Documentation à fournir (just the checked list)
  // "Offre de prix" is permanently included — it is always mandatory
  // (it doubles as the first quote of the workflow). The CheckboxList
  // below disables this row so the user cannot uncheck it.
  const [documentsProvided, setDocumentsProvided] = useState<string[]>([
    "Offre de prix",
  ]);

  // ── Step 7 – uploads, one per checked item in section 11 ──────
  const [files, setFiles] = useState<Record<string, File | null>>({});
  // When resuming a draft, files already uploaded the previous time are
  // hydrated here so the user can keep them, replace them, or remove
  // them without having to re-pick the original file from disk. The
  // mapping (section-11 label → document id) is persisted in the
  // workflow's `investmentForm.documentDocIds` field.
  const [existingDocs, setExistingDocs] = useState<
    Record<string, { id: number; filename: string; sizeBytes: number }>
  >({});

  // Default the department selector to the first one once departments
  // load — the user can change it but this avoids an empty required.
  useEffect(() => {
    if (!departmentId && departments && departments.length > 0) {
      setDepartmentId(String(departments[0].id));
    }
  }, [departments, departmentId]);

  // If the URL carries ?draftId=<n>, hydrate every form field from the
  // server-side draft once. The InvestmentForm uses real booleans /
  // numbers; the form state uses strings ("true" / "false" / "") so we
  // convert back here. This is the exact reverse of buildInvestmentForm.
  useEffect(() => {
    if (hydratedFromDraft) return;
    if (draftId == null) return;
    const wf = draftQuery.data;
    if (!wf) return;
    // Wait for the documents list to settle before hydrating — otherwise
    // workflow data can resolve first, the early-return guard flips on,
    // and `existingDocs` never picks up the previously uploaded files.
    if (!draftDocsQuery.isSuccess && !draftDocsQuery.isError) return;
    const b2s = (v: boolean | null | undefined): string =>
      v === true ? "true" : v === false ? "false" : "";
    const inv = (wf.investmentForm ?? {}) as Partial<InvestmentForm> & {
      livreIAnswer?: string | null;
      livreIIAnswer?: string | null;
    };
    if (wf.title) setTitle(wf.title);
    if (wf.priority) setPriority(wf.priority as keyof typeof Priority);
    if (wf.departmentId != null) setDepartmentId(String(wf.departmentId));
    if (wf.description) setDescription(wf.description);
    if (wf.category) setCategory(wf.category);
    if (inv.projectLeader) setProjectLeader(inv.projectLeader);
    if (Array.isArray(inv.investmentTypes)) {
      // "Autre: <text>" was packed by buildInvestmentForm — unpack it.
      const types: string[] = [];
      let other = "";
      for (const t of inv.investmentTypes) {
        if (t.startsWith("Autre:")) {
          types.push("Autre");
          other = t.slice("Autre:".length).trim();
        } else {
          types.push(t);
        }
      }
      setInvestmentTypes(types);
      if (other) setInvestmentTypeOther(other);
    }
    if (inv.justification) setJustification(inv.justification);
    setDemoTested(b2s(inv.demoTested));
    if (inv.demoContext) setDemoContext(inv.demoContext);
    if (inv.requestNature) setRequestNature(inv.requestNature);
    if (inv.replacedEquipmentRef) setReplacedEquipmentRef(inv.replacedEquipmentRef);
    if (inv.replacedEquipmentLocation) setReplacedEquipmentLocation(inv.replacedEquipmentLocation);
    if (inv.replacementReason) setReplacementReason(inv.replacementReason);
    setDecommissioned(b2s(inv.decommissioned));
    if (inv.decommissionedNote) setDecommissionedNote(inv.decommissionedNote);
    if (inv.estimatedAmount5y != null) setEstimatedAmount5y(String(inv.estimatedAmount5y));
    if (inv.livreIAnswer) setLivreIException(inv.livreIAnswer);
    if (inv.livreIIAnswer) setLivreIIException(inv.livreIIAnswer);
    if (inv.exceptionJustification) setExceptionJustification(inv.exceptionJustification);
    if (inv.budgetPositionKnown) setBudgetPositionKnown(inv.budgetPositionKnown);
    if (inv.budgetPosition) setBudgetPosition(inv.budgetPosition);
    if (inv.supplierCompanyId != null) {
      setSupplierCompanyId(String(inv.supplierCompanyId));
    } else if (inv.supplierName) {
      // Free-text supplier — buildInvestmentForm sets companyId=null.
      setSupplierCompanyId("NE_FIGURE_PAS");
      setSupplierFreeTextName(inv.supplierName);
      if (inv.supplierContact) setSupplierFreeTextContact(inv.supplierContact);
    }
    if (inv.supplierContactId != null) setSupplierContactId(String(inv.supplierContactId));
    setArchitecturalWorks(b2s(inv.architecturalWorks));
    setItConnection(b2s(inv.itConnection));
    setSystemInterop(b2s(inv.systemInterop));
    if (Array.isArray(inv.accessTypes)) setAccessTypes(inv.accessTypes);
    if (Array.isArray(inv.dataTypes)) setDataTypes(inv.dataTypes);
    if (inv.availabilityImpact) setAvailabilityImpact(inv.availabilityImpact);
    setHasAI(b2s(inv.hasAI));
    setConsumablesNeeded(b2s(inv.consumablesNeeded));
    setConsumablesOfferAttached(b2s(inv.consumablesOfferAttached));
    setHazardousConsumables(b2s(inv.hazardousConsumables));
    if (inv.warrantyDuration) setWarrantyDuration(inv.warrantyDuration);
    setMaintenanceContract(b2s(inv.maintenanceContract));
    setCleaningRequired(b2s(inv.cleaningRequired));
    setSterilizationRequired(b2s(inv.sterilizationRequired));
    setTrainingRequired(b2s(inv.trainingRequired));
    setTrainingOfferAttached(b2s(inv.trainingOfferAttached));
    if (inv.commissioningDate) setCommissioningDate(inv.commissioningDate);
    if (Array.isArray(inv.documentsProvided) && inv.documentsProvided.length) {
      setDocumentsProvided(inv.documentsProvided);
    }
    // Rehydrate the uploaded-files panel. The label → docId mapping is
    // stored on the workflow's investmentForm; we join it with the live
    // documents list so we can show each one's filename and size.
    const docIdMap = (inv as { documentDocIds?: Record<string, number> })
      .documentDocIds;
    if (docIdMap && draftDocsQuery.data) {
      const byId = new Map(draftDocsQuery.data.map((d) => [d.id, d]));
      const next: Record<
        string,
        { id: number; filename: string; sizeBytes: number }
      > = {};
      for (const [label, docId] of Object.entries(docIdMap)) {
        const doc = byId.get(docId);
        if (doc) {
          next[label] = {
            id: doc.id,
            filename: doc.filename,
            sizeBytes: doc.sizeBytes,
          };
        }
      }
      setExistingDocs(next);
    }
    setHydratedFromDraft(true);
    toast({ description: "Brouillon repris." });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, draftQuery.data, draftDocsQuery.data]);

  // Selected company → contacts list filtered for the 5.2 dropdown.
  // The list endpoint does not embed contacts, so we re-query the
  // single-company endpoint (CompanyWithContacts) once a supplier is
  // chosen.
  const selectedCompanySummary = useMemo(
    () =>
      supplierCompanyId
        ? (companies ?? []).find((c) => String(c.id) === supplierCompanyId) ?? null
        : null,
    [companies, supplierCompanyId],
  );
  // Passing 0 when no supplier is picked; the generated hook's
  // default `enabled: !!id` short-circuits the request.
  const { data: selectedCompanyFull } = useGetCompany(
    supplierCompanyId && supplierCompanyId !== "NE_FIGURE_PAS"
      ? Number(supplierCompanyId)
      : 0,
  );
  const supplierContacts = useMemo(
    () =>
      (selectedCompanyFull?.contacts ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [selectedCompanyFull],
  );
  // If the selected supplier changes, reset the contact selection.
  useEffect(() => {
    setSupplierContactId("");
  }, [supplierCompanyId]);

  // Q8.2 = "Oui" → auto-check "Offre de prix des consommables" in §11
  useEffect(() => {
    if (consumablesOfferAttached === "true") {
      setDocumentsProvided((prev) =>
        prev.includes("Offre de prix des consommables")
          ? prev
          : [...prev, "Offre de prix des consommables"],
      );
    }
  }, [consumablesOfferAttached]);

  // Q10.1.1 = "Oui" → auto-check "Offre de prix pour formation" in §11
  useEffect(() => {
    if (trainingOfferAttached === "true") {
      setDocumentsProvided((prev) =>
        prev.includes("Offre de prix pour formation")
          ? prev
          : [...prev, "Offre de prix pour formation"],
      );
    }
  }, [trainingOfferAttached]);

  // Q9.2 = "Oui" → auto-check "Offre de prix pour la maintenance" in §11
  useEffect(() => {
    if (maintenanceContract === "true") {
      setDocumentsProvided((prev) =>
        prev.includes("Offre de prix pour la maintenance")
          ? prev
          : [...prev, "Offre de prix pour la maintenance"],
      );
    }
  }, [maintenanceContract]);

  // Q1.4 investment type → pre-check related §11 docs
  useEffect(() => {
    const toAdd: string[] = [];
    if (
      investmentTypes.includes("Équipement médical") &&
      !documentsProvided.includes(DECLARATION_CONFORMITE_LABEL)
    ) {
      toAdd.push(DECLARATION_CONFORMITE_LABEL);
    }
    if (
      (investmentTypes.includes("Hardware IT") ||
        investmentTypes.includes("Équipement médical")) &&
      !documentsProvided.includes(CE_CERT_LABEL)
    ) {
      toAdd.push(CE_CERT_LABEL);
    }
    if (toAdd.length > 0) {
      setDocumentsProvided((prev) => [
        ...prev,
        ...toAdd.filter((d) => !prev.includes(d)),
      ]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [investmentTypes]);

  const create = useCreateWorkflow();
  const update = useUpdateWorkflow();

  function boolVal(v: string): boolean | null {
    if (v === "true") return true;
    if (v === "false") return false;
    return null;
  }

  function buildInvestmentForm(): InvestmentForm {
    const types = [...investmentTypes];
    if (types.includes("Autre") && investmentTypeOther.trim()) {
      const idx = types.indexOf("Autre");
      types[idx] = `Autre: ${investmentTypeOther.trim()}`;
    }
    const supplierCompany = selectedCompanySummary;
    const supplierContact = supplierContactId
      ? supplierContacts.find((c) => String(c.id) === supplierContactId)
      : null;
    return {
      projectLeader: projectLeader || null,
      investmentTypes: types.length ? types : undefined,
      justification: justification || null,
      demoTested: boolVal(demoTested),
      demoContext: demoContext || null,
      requestNature: requestNature || null,
      replacedEquipmentRef: replacedEquipmentRef || null,
      replacedEquipmentLocation: replacedEquipmentLocation || null,
      replacementReason: replacementReason || null,
      decommissioned: boolVal(decommissioned),
      decommissionedNote: decommissionedNote || null,
      estimatedAmount5y: estimatedAmount5y ? Number(estimatedAmount5y) : null,
      exceptionProcedure:
        tier === "BAND_XY" && livreIException === "true"
          ? "LIVRE_I"
          : tier === "ABOVE_Y" && livreIIException === "true"
            ? "LIVRE_II"
            : "NONE",
      // Raw answers (true / false / unknown / null) for Q4.1.1 and
      // Q4.1.3 — kept alongside `exceptionProcedure` so the legal
      // notification rule can fire on JNS / Non as well.
      livreIAnswer: tier === "BAND_XY" ? (livreIException || null) : null,
      livreIIAnswer: tier === "ABOVE_Y" ? (livreIIException || null) : null,
      exceptionJustification: exceptionJustification || null,
      budgetPositionKnown: budgetPositionKnown || null,
      budgetPosition: budgetPosition || null,
      supplierName:
        supplierCompanyId === "NE_FIGURE_PAS"
          ? supplierFreeTextName || null
          : (supplierCompany?.name ?? null),
      supplierContact:
        supplierCompanyId === "NE_FIGURE_PAS"
          ? supplierFreeTextContact || null
          : supplierContact
            ? [supplierContact.name, supplierContact.email, supplierContact.phone]
                .filter(Boolean)
                .join(" · ")
            : null,
      supplierCompanyId: supplierCompanyId === "NE_FIGURE_PAS" ? null : (supplierCompany?.id ?? null),
      supplierContactId: supplierCompanyId === "NE_FIGURE_PAS" ? null : (supplierContact?.id ?? null),
      architecturalWorks: boolVal(architecturalWorks),
      itConnection: boolVal(itConnection),
      systemInterop: boolVal(systemInterop),
      accessTypes: accessTypes.length ? accessTypes : undefined,
      dataTypes: dataTypes.length ? dataTypes : undefined,
      availabilityImpact: availabilityImpact || null,
      hasAI: boolVal(hasAI),
      consumablesNeeded: boolVal(consumablesNeeded),
      consumablesOfferAttached: boolVal(consumablesOfferAttached),
      hazardousConsumables: boolVal(hazardousConsumables),
      warrantyDuration: warrantyDuration || null,
      maintenanceContract: boolVal(maintenanceContract),
      cleaningRequired: boolVal(cleaningRequired),
      sterilizationRequired: boolVal(sterilizationRequired),
      trainingRequired: boolVal(trainingRequired),
      trainingOfferAttached: boolVal(trainingOfferAttached),
      commissioningDate: commissioningDate || null,
      documentsProvided: documentsProvided.length ? documentsProvided : undefined,
      // Carry the label → docId map so reopening a draft still finds
      // its attached files. Callers that have just uploaded new files
      // merge their fresh ids in via `buildInvestmentFormWithDocs`.
      ...(Object.keys(existingDocs).length > 0
        ? {
            documentDocIds: Object.fromEntries(
              Object.entries(existingDocs).map(([k, v]) => [k, v.id]),
            ),
          }
        : {}),
    } as InvestmentForm;
  }

  // Variant used right after uploading new files on a draft save. The
  // returned form merges the freshly-uploaded ids into documentDocIds
  // so the workflow row records the link in one PATCH.
  function buildInvestmentFormWithDocs(
    freshDocIds: Record<string, number>,
  ): InvestmentForm {
    const base = buildInvestmentForm() as InvestmentForm & {
      documentDocIds?: Record<string, number>;
    };
    const merged: Record<string, number> = {
      ...(base.documentDocIds ?? {}),
      ...freshDocIds,
    };
    return {
      ...base,
      ...(Object.keys(merged).length > 0 ? { documentDocIds: merged } : {}),
    } as InvestmentForm;
  }

  // Per-step validation: lists the missing fields for the current page.
  // Used both to gate the "Suivant" button (with showErrors=true after
  // a click) and to render the inline error alert.
  function missingForStep(s: number): string[] {
    const m: string[] = [];
    if (s === 1) {
      if (!title.trim()) m.push("Titre de la Demande");
      if (!departmentId) m.push("Département");
      if (!projectLeader.trim()) m.push("1.3 Responsable / Leader du projet");
      if (investmentTypes.length === 0)
        m.push("1.4 Type(s) d'investissement");
      if (
        investmentTypes.includes("Autre") &&
        !investmentTypeOther.trim()
      )
        m.push("1.4 Précision pour « Autre »");
    }
    if (s === 2) {
      if (!description.trim()) m.push("2.1 Description détaillée");
      if (!justification.trim()) m.push("2.2 Justification");
      if (!demoTested) m.push("2.3 Testé en demo");
      if (demoTested === "true" && !demoContext.trim())
        m.push("2.3 Contexte du test");
    }
    if (s === 3) {
      if (!requestNature) m.push("3.1 Nature de la demande");
      if (requestNature === "REPLACEMENT") {
        if (!replacedEquipmentRef.trim())
          m.push("3.1.1 Numéro / nom de l'équipement remplacé");
        if (!replacedEquipmentLocation.trim())
          m.push("3.1.2 Localisation");
        if (!replacementReason.trim()) m.push("3.1.3 Motif du remplacement");
        if (!decommissioned) m.push("3.1.4 Mise hors service");
        if (decommissioned === "false" && !decommissionedNote.trim())
          m.push("3.1.4 Précision sur le devenir de l'équipement");
      }
      if (!estimatedAmount5y) m.push("4.1 Coût estimé sur 5 ans");
      if (tier === "BAND_XY" && !livreIException)
        m.push("4.1.1 Procédure d'exception Livre I");
      if (tier === "BAND_XY" && livreIException === "true" && !exceptionJustification.trim())
        m.push("4.1.2 Justification procédure d'exception Livre I");
      if (tier === "ABOVE_Y" && !livreIIException)
        m.push("4.1.3 Procédure d'exception Livre II");
      if (tier === "ABOVE_Y" && livreIIException === "true" && !exceptionJustification.trim())
        m.push("4.1.4 Justification procédure d'exception Livre II");
      if (!budgetPositionKnown) m.push("4.2 Position budgétaire connue");
      if (budgetPositionKnown === "YES" && !budgetPosition.trim()) m.push("4.2.1 Position budgétaire");
    }
    if (s === 4) {
      if (!supplierCompanyId) m.push("5.1 Nom du fournisseur");
      if (supplierCompanyId === "NE_FIGURE_PAS") {
        if (!supplierFreeTextName.trim()) m.push("5.1 Nom du fournisseur (texte libre)");
      } else if (supplierCompanyId && !supplierContactId) {
        m.push("5.2 Personne de contact");
      }
      if (!architecturalWorks) m.push("6.1 Aménagements architecturaux");
      if (!itConnection) m.push("6.2 Connexion informatique");
      if (!systemInterop) m.push("6.3 Interopérabilité systèmes critiques");
      if (systemInterop === "true" && accessTypes.length === 0)
        m.push("6.3.1 Type d'accès");
    }
    if (s === 5) {
      if (dataTypes.length === 0) m.push("7.1 Types de données traitées");
      if (!availabilityImpact) m.push("7.2 Impact en cas d'indisponibilité");
      if (!hasAI) m.push("7.3 Intelligence artificielle");
      if (!consumablesNeeded) m.push("8.1 Consommables nécessaires");
      if (consumablesNeeded === "true" && !consumablesOfferAttached)
        m.push("8.2 Offre des consommables jointe");
      if (!hazardousConsumables) m.push("8.3 Gaz / produits chimiques");
    }
    if (s === 6) {
      if (!warrantyDuration.trim()) m.push("9.1 Durée de la garantie");
      if (!maintenanceContract) m.push("9.2 Contrat de maintenance");
      if (!cleaningRequired) m.push("9.4 Nettoyage / désinfection");
      if (!sterilizationRequired) m.push("9.5 Stérilisation");
      if (!trainingRequired) m.push("10.1 Formation nécessaire");
      if (trainingRequired === "true" && !trainingOfferAttached)
        m.push("10.1.1 Offre de formation jointe");
      if (!commissioningDate) m.push("10.2 Date de mise en service");
      if (documentsProvided.length === 0)
        m.push("11 Documents à fournir (cocher au moins un)");
    }
    if (s === 7) {
      for (const d of documentsProvided) {
        // A label is satisfied either by a freshly-picked File or by a
        // document carried over from a resumed draft.
        if (!files[d] && !existingDocs[d]) m.push(`Fichier pour « ${d} »`);
      }
    }
    return m;
  }

  const currentMissing = missingForStep(step);
  const canAdvance = currentMissing.length === 0;

  function handleNext() {
    if (!canAdvance) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setStep((s) => s + 1);
  }

  const DRAFT_KEY = "purchasing-workflow-draft";
  // Server-side draft: same payload as a real submission but with
  // asDraft=true, which parks the workflow in the DRAFT step. The
  // browser-local draft (below) is kept as a separate convenience —
  // it preserves the unsaved form state across navigations even
  // before the user has picked a department/title.
  async function handleSaveAsServerDraft() {
    // A draft is intentionally allowed to be incomplete — the user
    // can come back later to finish it. We only require the bare
    // minimum the server demands (title + department + priority) so
    // the workflow row can actually be persisted.
    if (!title.trim() || !departmentId) {
      toast({
        variant: "destructive",
        description:
          "Renseignez au moins un titre et un département pour enregistrer le brouillon.",
      });
      return;
    }
    setSubmitting(true);
    try {
      let savedId: number;
      if (draftId != null) {
        // Resuming an existing draft — PATCH the same row instead of
        // creating a new workflow each time the user re-saves.
        const wf = await update.mutateAsync({
          id: draftId,
          data: {
            title,
            priority,
            description: description || null,
            category: category || null,
            neededBy: commissioningDate || null,
            investmentForm: buildInvestmentForm(),
          },
        });
        savedId = wf.id;
      } else {
        const wf = await create.mutateAsync({
          data: {
            title,
            departmentId: Number(departmentId),
            priority,
            description: description || null,
            category: category || null,
            estimatedAmount: null,
            currency: null,
            neededBy: commissioningDate || null,
            investmentForm: buildInvestmentForm(),
            asDraft: true,
          },
        });
        savedId = wf.id;
      }

      // Upload any files the user picked in section 12, mapping each
      // back to its section-11 label so a resumed draft can show the
      // attachments without forcing the user to re-pick them. We use
      // step="DRAFT" so the upload is allowed on a workflow that
      // hasn't advanced past the DRAFT step yet.
      const freshDocIds: Record<string, number> = {};
      for (const label of documentsProvided) {
        const file = files[label];
        if (!file) continue;
        const fd = new FormData();
        fd.append("file", file);
        fd.append("step", "DRAFT");
        fd.append("kind", docKindFor(label));
        const r = await fetch(`/api/workflows/${savedId}/documents`, {
          method: "POST",
          body: fd,
          credentials: "include",
        });
        if (!r.ok) {
          const txt = await r.text();
          throw new Error(`Upload failed for « ${label} »: ${txt}`);
        }
        const doc = (await r.json()) as { id: number };
        freshDocIds[label] = doc.id;
      }
      // If new files were uploaded, persist the updated label → docId
      // map onto the workflow's investmentForm so we can rehydrate
      // them on reopen.
      if (Object.keys(freshDocIds).length > 0) {
        await update.mutateAsync({
          id: savedId,
          data: { investmentForm: buildInvestmentFormWithDocs(freshDocIds) },
        });
      }
      localStorage.removeItem(DRAFT_KEY);
      qc.invalidateQueries();
      toast({ description: "Brouillon enregistré." });
      // Send the user back to the Demandes list — drafts are picked
      // back up from there, not from the workflow detail page (which
      // would jump straight to the Offre de prix step).
      setLocation("/workflows");
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Brouillon non enregistré",
        description: extractApiError(err, "Le brouillon n'a pas pu être créé."),
      });
    } finally {
      setSubmitting(false);
    }
  }

  function handlePrev() {
    setShowErrors(false);
    setStep((s) => Math.max(1, s - 1));
  }

  // Submit: create the workflow, then upload each section-11 document
  // sequentially (so we can capture the returned doc IDs), then — if
  // an "Offre de prix" was uploaded — PATCH the workflow's `quotes`
  // with that document attached as the first (winning, by default
  // when there's only one) quote, supplier pre-filled from 5.1.
  async function onSubmit() {
    if (!canAdvance) {
      setShowErrors(true);
      return;
    }
    setSubmitting(true);
    try {
      let wf: Workflow;
      if (draftId != null) {
        // Resuming a server-side draft: PATCH the existing row, then
        // advance it from DRAFT to QUOTATION so the rest of the flow
        // (document upload + quote materialisation) proceeds the same
        // way as for a fresh creation.
        wf = await update.mutateAsync({
          id: draftId,
          data: {
            title,
            priority,
            description: description || null,
            category: category || null,
            neededBy: commissioningDate || null,
            investmentForm: buildInvestmentForm(),
          },
        });
        wf = await advance.mutateAsync({ id: draftId, data: {} });
      } else {
        wf = await create.mutateAsync({
          data: {
            title,
            departmentId: Number(departmentId),
            priority,
            description: description || null,
            category: category || null,
            estimatedAmount: null,
            currency: null,
            neededBy: commissioningDate || null,
            investmentForm: buildInvestmentForm(),
          },
        });
      }

      // Upload every checked document. Multipart fetch directly — the
      // codegen client also exposes UploadWorkflowDocumentBodyTwo for
      // multipart, but a plain fetch is simpler than juggling the
      // generated discriminator.
      let offrePrixDocId: number | null = null;
      for (const label of documentsProvided) {
        const file = files[label];
        if (!file) {
          // No fresh file picked — but a file from a resumed draft may
          // already be attached. Reuse its id (notably for the "Offre
          // de prix" → first quote linkage below).
          const existing = existingDocs[label];
          if (existing && label === "Offre de prix") {
            offrePrixDocId = existing.id;
          }
          continue;
        }
        const fd = new FormData();
        fd.append("file", file);
        fd.append("step", "QUOTATION");
        fd.append("kind", docKindFor(label));
        const r = await fetch(`/api/workflows/${wf.id}/documents`, {
          method: "POST",
          body: fd,
          credentials: "include",
        });
        if (!r.ok) {
          const txt = await r.text();
          throw new Error(`Upload failed for « ${label} »: ${txt}`);
        }
        const doc = (await r.json()) as { id: number };
        if (label === "Offre de prix") offrePrixDocId = doc.id;
      }

      // If an "Offre de prix" was uploaded, materialise it as the
      // first quote of the workflow. The supplier (5.1) is pre-filled
      // and the document is linked. Amount is left null — the user
      // enters it on the QUOTATION step. With a single quote, the
      // server will treat it as the winner.
      if (offrePrixDocId != null && supplierCompanyId) {
        const isFreeText = supplierCompanyId === "NE_FIGURE_PAS";
        const company = isFreeText
          ? null
          : (companies ?? []).find(
              (c) => String(c.id) === supplierCompanyId,
            ) ?? null;
        // Free-text supplier: no FK to companies/contacts, but we still
        // record the typed-in name on the quote line so the workflow
        // detail (which reads supplier from `quotes[].companyName`)
        // displays it instead of "—".
        await update.mutateAsync({
          id: wf.id,
          data: {
            quotes: [
              {
                companyId: isFreeText ? null : Number(supplierCompanyId),
                companyName: isFreeText
                  ? supplierFreeTextName.trim() || null
                  : company?.name ?? null,
                contactId:
                  !isFreeText && supplierContactId
                    ? Number(supplierContactId)
                    : null,
                amount: null,
                currency: null,
                notes: null,
                winning: true,
                documentIds: [offrePrixDocId],
              },
            ],
          },
        });
      }

      localStorage.removeItem("purchasing-workflow-draft");
      qc.invalidateQueries();
      setLocation(`/workflows/${wf.id}`);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Création impossible",
        description: extractApiError(err, "La demande n'a pas pu être créée."),
      });
    } finally {
      setSubmitting(false);
    }
  }

  const progressPct = ((step - 1) / TOTAL_STEPS) * 100;
  const budgetPositionsList = (settings?.budgetPositions ?? [])
    .slice()
    .sort((a, b) => a.localeCompare(b, "fr"));

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setLocation("/workflows")}
        data-testid="button-back"
      >
        <ArrowLeft className="mr-2 h-4 w-4" /> Back
      </Button>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">Nouvelle demande d'investissement</h1>
          </div>
          <span className="text-sm text-muted-foreground">
            Étape {step} / {TOTAL_STEPS} — {STEP_LABELS[step - 1]}
          </span>
        </div>
        <Progress value={progressPct} className="h-1.5" />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{STEP_LABELS[step - 1]}</CardTitle>
          {step === 1 && (
            <CardDescription>
              Informations de base sur la demande et le projet. Tous les champs marqués <Req /> sont obligatoires.
            </CardDescription>
          )}
          {step === 2 && (
            <CardDescription>
              Description détaillée et justification de l'investissement.
            </CardDescription>
          )}
          {step === 3 && (
            <CardDescription>
              Nature de la demande (achat neuf ou remplacement) et aspects financiers.
            </CardDescription>
          )}
          {step === 4 && (
            <CardDescription>
              Fournisseur envisagé et aspects techniques / infrastructure.
            </CardDescription>
          )}
          {step === 5 && (
            <CardDescription>
              Données traitées, sécurité et gestion des consommables.
            </CardDescription>
          )}
          {step === 6 && (
            <CardDescription>
              Maintenance, formation, mise en service et liste des documents joints.
            </CardDescription>
          )}
          {step === 7 && (
            <CardDescription>
              Joindre un fichier pour chaque document coché à la section 11. Tous les fichiers sont obligatoires.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-6">

          {/* ── STEP 1 ─────────────────────────────────────────────── */}
          {step === 1 && (
            <>
              <SectionTitle number="0" label="Demande" />
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="title">Titre de la Demande<Req /></Label>
                  <Input
                    id="title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="ex. Acquisition scanner IRM"
                    data-testid="input-title"
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Service / Département<Req /></Label>
                    <Select value={departmentId} onValueChange={setDepartmentId}>
                      <SelectTrigger data-testid="select-department">
                        <SelectValue placeholder="Sélectionner..." />
                      </SelectTrigger>
                      <SelectContent>
                        {(departments ?? []).map((d) => (
                          <SelectItem key={d.id} value={String(d.id)}>
                            {d.name} ({d.code})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Priorité</Label>
                    <Select
                      value={priority}
                      onValueChange={(v) => setPriority(v as keyof typeof Priority)}
                    >
                      <SelectTrigger data-testid="select-priority">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NORMAL">Normal</SelectItem>
                        <SelectItem value="URGENT">Urgent</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              <SectionTitle number="1" label="Identification générale" />
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="projectLeader">1.3 Responsable / Leader du projet<Req /></Label>
                  <Input
                    id="projectLeader"
                    value={projectLeader}
                    onChange={(e) => setProjectLeader(e.target.value)}
                    data-testid="input-project-leader"
                  />
                </div>
                <div className="space-y-2">
                  <Label>1.4 Type d'investissement (cocher les cases appropriées)<Req /></Label>
                  <CheckboxList
                    options={INVESTMENT_TYPES}
                    values={investmentTypes}
                    onChange={setInvestmentTypes}
                  />
                  {investmentTypes.includes("Autre") && (
                    <div className="mt-2 space-y-1.5">
                      <Label>Préciser « Autre »<Req /></Label>
                      <Input
                        placeholder="Préciser..."
                        value={investmentTypeOther}
                        onChange={(e) => setInvestmentTypeOther(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* ── STEP 2 ─────────────────────────────────────────────── */}
          {step === 2 && (
            <>
              <SectionTitle number="2" label="Description du besoin et justification" />
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="description">
                    2.1 Description détaillée de l'équipement / investissement<Req />
                  </Label>
                  <Textarea
                    id="description"
                    rows={4}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    data-testid="input-description"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="justification">
                    2.2 Argumentaire – justification de l'investissement<Req />
                  </Label>
                  <Textarea
                    id="justification"
                    rows={4}
                    value={justification}
                    onChange={(e) => setJustification(e.target.value)}
                    placeholder="Besoin, objectifs, bénéfices attendus..."
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>2.3 L'équipement a-t-il déjà été testé en Demo au CHdN ?<Req /></Label>
                  <YesNoSelect value={demoTested} onChange={setDemoTested} />
                </div>
                {demoTested === "true" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="demoContext">Préciser le contexte du test<Req /></Label>
                    <Textarea
                      id="demoContext"
                      rows={2}
                      value={demoContext}
                      onChange={(e) => setDemoContext(e.target.value)}
                    />
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── STEP 3 ─────────────────────────────────────────────── */}
          {step === 3 && (
            <>
              <SectionTitle number="3" label="Nature de la demande" />
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label>3.1 Nature de la demande<Req /></Label>
                  <Select value={requestNature} onValueChange={setRequestNature}>
                    <SelectTrigger>
                      <SelectValue placeholder="Sélectionner..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NEW">Nouvel achat</SelectItem>
                      <SelectItem value="REPLACEMENT">Remplacement</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {requestNature === "REPLACEMENT" && (
                  <div className="rounded-md border p-4 space-y-4 bg-muted/30">
                    <div className="space-y-1.5">
                      <Label>3.1.1 Numéro d'équipement / numéro de série ou nom remplacé<Req /></Label>
                      <Input
                        value={replacedEquipmentRef}
                        onChange={(e) => setReplacedEquipmentRef(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>3.1.2 Localisation de l'équipement existant<Req /></Label>
                      <Input
                        value={replacedEquipmentLocation}
                        onChange={(e) => setReplacedEquipmentLocation(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>3.1.3 Motif du remplacement<Req /></Label>
                      <Textarea
                        rows={2}
                        value={replacementReason}
                        onChange={(e) => setReplacementReason(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>3.1.4 L'ancien équipement sera-t-il mis hors service ?<Req /></Label>
                      <YesNoSelect value={decommissioned} onChange={setDecommissioned} />
                    </div>
                    {decommissioned === "false" && (
                      <div className="space-y-1.5">
                        <Label>Préciser ce qu'il deviendra<Req /></Label>
                        <Textarea
                          rows={2}
                          value={decommissionedNote}
                          onChange={(e) => setDecommissionedNote(e.target.value)}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>

              <SectionTitle number="4" label="Aspects financiers" />
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="amount5y">
                    4.1 Coût total estimé sur 5 années (HTVA)<Req />
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Inclure : achat, maintenance, consommables, formation, abonnements.
                  </p>
                  <Input
                    id="amount5y"
                    type="number"
                    step="0.01"
                    value={estimatedAmount5y}
                    onChange={(e) => {
                      setEstimatedAmount5y(e.target.value);
                      setLivreIException("");
                      setLivreIIException("");
                      setExceptionJustification("");
                    }}
                    placeholder="Montant total HTVA"
                  />
                  {tier === "BAND_XY" && (
                    <p className="text-xs text-amber-600">
                      Besoin de 3 Offres ou Procédure d&apos;exception Livre I (Marchés au-dessous des seuils européens).
                    </p>
                  )}
                  {tier === "ABOVE_Y" && (
                    <p className="text-xs text-amber-600">
                      Démarche marché international ou procédure d&apos;exception Livre II.
                    </p>
                  )}
                </div>

                {/* ── Q4.1.1 : exception Livre I ? (band X–Y only) ── */}
                {tier === "BAND_XY" && (
                  <div className="space-y-3 rounded-md border p-4 bg-muted/30">
                    <div className="space-y-1.5">
                      <Label>
                        4.1.1 La demande relève-t-elle d&apos;une procédure d&apos;exception Livre I ?<Req />
                      </Label>
                      <YesNoMaybeSelect value={livreIException} onChange={(v) => {
                        setLivreIException(v);
                        setExceptionJustification("");
                      }} />
                    </div>
                    {livreIException === "false" && (
                      <p className="text-xs text-amber-600">
                        Besoin de 3 Offres, voir import après création de la demande.
                      </p>
                    )}
                    {(livreIException === "true" || livreIException === "unknown") && (
                      <p className="text-xs text-amber-600 font-medium">
                        Le service juridique sera notifié.
                      </p>
                    )}
                    {livreIException === "true" && (
                      <div className="space-y-1.5">
                        <Label>
                          4.1.2 Justification détaillée de la procédure d&apos;exception Livre I<Req />
                        </Label>
                        <Textarea
                          rows={3}
                          value={exceptionJustification}
                          onChange={(e) => setExceptionJustification(e.target.value)}
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* ── Q4.1.3 : exception Livre II ? (above Y) ── */}
                {tier === "ABOVE_Y" && (
                  <div className="space-y-3 rounded-md border p-4 bg-muted/30">
                    <div className="space-y-1.5">
                      <Label>
                        4.1.3 La demande relève-t-elle d&apos;une procédure d&apos;exception Livre II ?<Req />
                      </Label>
                      <YesNoMaybeSelect value={livreIIException} onChange={(v) => {
                        setLivreIIException(v);
                        setExceptionJustification("");
                      }} />
                    </div>
                    {livreIIException !== "" && (
                      <p className="text-xs text-amber-600 font-medium">
                        Le service juridique sera notifié.
                      </p>
                    )}
                    {livreIIException === "true" && (
                      <div className="space-y-1.5">
                        <Label>
                          4.1.4 Justification détaillée de la procédure d&apos;exception Livre II<Req />
                        </Label>
                        <Textarea
                          rows={3}
                          value={exceptionJustification}
                          onChange={(e) => setExceptionJustification(e.target.value)}
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label>4.2 La position budgétaire est-elle connue ?<Req /></Label>
                  <Select value={budgetPositionKnown} onValueChange={setBudgetPositionKnown}>
                    <SelectTrigger>
                      <SelectValue placeholder="Sélectionner..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="YES">Oui</SelectItem>
                      <SelectItem value="NO">Non</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {budgetPositionKnown === "YES" && (
                  <div className="space-y-1.5">
                    <Label>4.2.1 Position budgétaire (selon liste GT Invest)<Req /></Label>
                    {budgetPositionsList.length === 0 ? (
                      <Alert variant="destructive">
                        <AlertDescription className="text-xs">
                          Aucune position budgétaire n&apos;est configurée. Un administrateur doit en ajouter dans Paramètres → GT Invest avant de pouvoir créer un workflow.
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <Select value={budgetPosition} onValueChange={setBudgetPosition}>
                        <SelectTrigger data-testid="select-budget-position">
                          <SelectValue placeholder="Sélectionner..." />
                        </SelectTrigger>
                        <SelectContent>
                          {budgetPositionsList.map((p) => (
                            <SelectItem key={p} value={p}>
                              {p}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── STEP 4 ─────────────────────────────────────────────── */}
          {step === 4 && (
            <>
              <SectionTitle number="5" label="Fournisseur" />
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label>5.1 Nom du fournisseur<Req /></Label>
                  {(companies ?? []).length === 0 ? (
                    <Alert variant="destructive">
                      <AlertDescription className="text-xs">
                        Aucun fournisseur n'est enregistré. Ajoutez-en un dans la page Fournisseurs avant de continuer.
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <>
                      <Select
                        value={supplierCompanyId}
                        onValueChange={(v) => {
                          setSupplierCompanyId(v);
                          setSupplierContactId("");
                          setSupplierFreeTextName("");
                          setSupplierFreeTextContact("");
                        }}
                      >
                        <SelectTrigger data-testid="select-supplier-company">
                          <SelectValue placeholder="Sélectionner un fournisseur..." />
                        </SelectTrigger>
                        <SelectContent className="max-h-64">
                          <SelectItem value="NE_FIGURE_PAS">
                            — Ne figure pas dans la liste
                          </SelectItem>
                          {(companies ?? [])
                            .slice()
                            .sort((a, b) => a.name.localeCompare(b.name))
                            .map((c) => (
                              <SelectItem key={c.id} value={String(c.id)}>
                                {c.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      {supplierCompanyId === "NE_FIGURE_PAS" && (
                        <div className="mt-2 space-y-2 rounded-md border p-3 bg-muted/20">
                          <div className="space-y-1.5">
                            <Label className="text-xs font-medium">
                              Nom du fournisseur<Req />
                            </Label>
                            <Input
                              value={supplierFreeTextName}
                              onChange={(e) => setSupplierFreeTextName(e.target.value)}
                              placeholder="Saisir le nom du fournisseur..."
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs font-medium">
                              Personne de contact
                            </Label>
                            <Input
                              value={supplierFreeTextContact}
                              onChange={(e) => setSupplierFreeTextContact(e.target.value)}
                              placeholder="Saisir le nom du contact..."
                            />
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
                {supplierCompanyId !== "NE_FIGURE_PAS" && (
                <div className="space-y-1.5">
                  <Label>5.2 Personne de contact<Req /></Label>
                  {!supplierCompanyId ? (
                    <p className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                      Sélectionner d'abord un fournisseur ci-dessus.
                    </p>
                  ) : supplierContacts.length === 0 ? (
                    <Alert variant="destructive">
                      <AlertDescription className="text-xs">
                        Ce fournisseur n'a aucun contact enregistré. Ajoutez-en un dans la page Fournisseurs avant de continuer.
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <Select value={supplierContactId} onValueChange={setSupplierContactId}>
                      <SelectTrigger data-testid="select-supplier-contact">
                        <SelectValue placeholder="Sélectionner un contact..." />
                      </SelectTrigger>
                      <SelectContent className="max-h-64">
                        {supplierContacts.map((c) => (
                          <SelectItem key={c.id} value={String(c.id)}>
                            {c.name}
                            {c.email ? ` · ${c.email}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                )}
              </div>

              <SectionTitle number="6" label="Aspects techniques et infrastructure" />
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>6.1 Aménagements architecturaux ou techniques nécessaires ?<Req /></Label>
                    <YesNoSelect value={architecturalWorks} onChange={setArchitecturalWorks} />
                    {architecturalWorks === "true" && (
                      <p className="text-xs text-amber-600">
                        Le service Technique sera notifié.
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label>6.2 Connexion informatique requise ?<Req /></Label>
                    <YesNoSelect value={itConnection} onChange={setItConnection} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>
                    6.3 Accès ou interopérabilité avec des systèmes critiques (DPI, IT…) ?<Req />
                  </Label>
                  <YesNoSelect value={systemInterop} onChange={setSystemInterop} />
                </div>
                {systemInterop === "true" && (
                  <div className="space-y-2 rounded-md border p-4 bg-muted/30">
                    <Label>6.3.1 Type d&apos;accès<Req /></Label>
                    <CheckboxList
                      options={ACCESS_TYPES}
                      values={accessTypes}
                      onChange={setAccessTypes}
                    />
                    {accessTypes.length > 0 && (
                      <p className="text-xs text-amber-600 font-medium">
                        Le Service Informatique et Sécurité informatique seront notifiés.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── STEP 5 ─────────────────────────────────────────────── */}
          {step === 5 && (
            <>
              <SectionTitle number="7" label="Données, sécurité et conformité" />
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>7.1 L'équipement / la solution traite-t-il ou donne-t-il accès à :<Req /></Label>
                  <CheckboxList
                    options={DATA_TYPES}
                    values={dataTypes}
                    onChange={setDataTypes}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>7.2 Impact potentiel en cas d'indisponibilité du système<Req /></Label>
                  <Select value={availabilityImpact} onValueChange={setAvailabilityImpact}>
                    <SelectTrigger>
                      <SelectValue placeholder="Sélectionner..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CRITICAL">Critique (interruption des soins)</SelectItem>
                      <SelectItem value="MODERATE">Modéré (perturbation des opérations)</SelectItem>
                      <SelectItem value="MINOR">Mineur</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>7.3 L'offre inclut-elle de l'intelligence artificielle ?<Req /></Label>
                  <YesNoSelect value={hasAI} onChange={setHasAI} />
                  {hasAI === "true" && (
                    <p className="text-xs text-amber-600">
                      Validation DPO requise. Le service juridique sera notifié.
                    </p>
                  )}
                </div>
              </div>

              <SectionTitle number="8" label="Consommables et sécurité" />
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label>8.1 Des consommables sont-ils nécessaires (EPI inclus) ?<Req /></Label>
                  <YesNoSelect value={consumablesNeeded} onChange={setConsumablesNeeded} />
                </div>
                {consumablesNeeded === "true" && (
                  <div className="space-y-1.5">
                    <Label>8.2 Offre des consommables jointe ?<Req /></Label>
                    <YesNoSelect
                      value={consumablesOfferAttached}
                      onChange={setConsumablesOfferAttached}
                    />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label>8.3 Les consommables incluent-ils des gaz ou produits chimiques ?<Req /></Label>
                  <YesNoSelect value={hazardousConsumables} onChange={setHazardousConsumables} />
                  {hazardousConsumables === "true" && (
                    <p className="text-xs text-amber-600">
                      Le service Protection et Prévention sera notifié.
                    </p>
                  )}
                </div>
              </div>
            </>
          )}

          {/* ── STEP 6 ─────────────────────────────────────────────── */}
          {step === 6 && (
            <>
              <SectionTitle number="9" label="Maintenance, hygiène et exploitation" />
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label>9.1 Durée de la garantie<Req /></Label>
                  <Input
                    value={warrantyDuration}
                    onChange={(e) => setWarrantyDuration(e.target.value)}
                    placeholder="ex. 2 ans"
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label>9.2 Contrat de maintenance nécessaire ?<Req /></Label>
                    <YesNoSelect value={maintenanceContract} onChange={setMaintenanceContract} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>9.4 Nettoyage / désinfection requis ?<Req /></Label>
                    <YesNoSelect value={cleaningRequired} onChange={setCleaningRequired} />
                    {cleaningRequired === "true" && (
                      <p className="text-xs text-amber-600">Le service SPCI sera notifié.</p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label>9.5 Stérilisation requise ?<Req /></Label>
                    <YesNoSelect value={sterilizationRequired} onChange={setSterilizationRequired} />
                    {sterilizationRequired === "true" && (
                      <p className="text-xs text-amber-600">Le service Stérilisation sera notifié.</p>
                    )}
                  </div>
                </div>
              </div>

              <SectionTitle number="10" label="Formation et mise en service" />
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label>10.1 Une formation pour les utilisateurs est-elle nécessaire ?<Req /></Label>
                  <YesNoSelect value={trainingRequired} onChange={setTrainingRequired} />
                </div>
                {trainingRequired === "true" && (
                  <div className="space-y-1.5">
                    <Label>10.1.1 Offre de formation jointe ?<Req /></Label>
                    <YesNoSelect
                      value={trainingOfferAttached}
                      onChange={setTrainingOfferAttached}
                    />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="commissioningDate">
                    10.2 Date souhaitée de mise en production / service<Req />
                  </Label>
                  <DatePicker
                    value={commissioningDate}
                    onChange={setCommissioningDate}
                    data-testid="input-neededby"
                  />
                </div>
              </div>

              <SectionTitle number="11" label="Documentation obligatoire à fournir" />
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Cocher les documents qui seront joints. Vous pourrez les déposer à l'étape suivante. L'« Offre de prix » est toujours obligatoire.<Req />
                </p>
                <CheckboxList
                  options={REQUIRED_DOCS}
                  values={documentsProvided}
                  disabledOptions={["Offre de prix"]}
                  onChange={(v) => {
                    // Force "Offre de prix" to stay in the list even if
                    // the CheckboxList ever lets it through.
                    const forced = v.includes("Offre de prix")
                      ? v
                      : ["Offre de prix", ...v];
                    setDocumentsProvided(forced);
                    // Drop any file selection for items that were just unchecked.
                    setFiles((f) => {
                      const next: Record<string, File | null> = {};
                      for (const k of forced) next[k] = f[k] ?? null;
                      return next;
                    });
                  }}
                  optionLabels={{
                    [CE_CERT_LABEL]: (
                      <span>
                        Certificat CE{" "}
                        <strong>(obligatoire si équipement médical ou hardware)</strong>
                      </span>
                    ),
                  }}
                />
              </div>
            </>
          )}

          {/* ── STEP 7 — uploads for every checked Section 11 doc ── */}
          {step === 7 && (
            <>
              <SectionTitle number="12" label="Dépôt de documents" />
              {documentsProvided.length === 0 ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    Aucun document n'a été coché à la section 11. Revenez à l'étape précédente pour en cocher au moins un.
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="space-y-4">
                  <p className="text-xs text-muted-foreground">
                    Téléversez le fichier correspondant à chaque document coché. Tous les fichiers sont obligatoires. L'« Offre de prix » sera enregistrée comme premier devis du workflow, avec le fournisseur sélectionné en 5.1.
                  </p>
                  {documentsProvided.map((label) => {
                    const f = files[label] ?? null;
                    const existing = existingDocs[label] ?? null;
                    return (
                      <div
                        key={label}
                        className="rounded-md border p-3 space-y-2"
                        data-testid={`upload-row-${label}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <Label className="text-sm font-medium leading-snug">
                            {label}
                            <Req />
                          </Label>
                          {label === "Offre de prix" && (
                            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-primary">
                              Premier devis
                            </span>
                          )}
                        </div>
                        {f ? (
                          <div className="flex items-center justify-between gap-2 rounded bg-muted/40 px-3 py-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <FileText className="h-4 w-4 flex-shrink-0 text-primary" />
                              <span className="truncate text-sm">{f.name}</span>
                              <span className="text-xs text-muted-foreground">
                                ({Math.round(f.size / 1024)} KB)
                              </span>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() =>
                                setFiles((m) => ({ ...m, [label]: null }))
                              }
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : existing ? (
                          <div className="flex items-center justify-between gap-2 rounded bg-muted/40 px-3 py-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <FileText className="h-4 w-4 flex-shrink-0 text-primary" />
                              <span className="truncate text-sm">
                                {existing.filename}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                ({Math.round(existing.sizeBytes / 1024)} KB)
                              </span>
                              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">
                                Déjà déposé
                              </span>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() =>
                                setExistingDocs((m) => {
                                  const { [label]: _omit, ...rest } = m;
                                  return rest;
                                })
                              }
                              data-testid={`remove-existing-${label}`}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : (
                          <label className="flex cursor-pointer items-center gap-2 rounded border border-dashed px-3 py-2 text-sm text-muted-foreground hover:bg-muted/40">
                            <Upload className="h-4 w-4" />
                            <span>Choisir un fichier…</span>
                            <input
                              type="file"
                              className="sr-only"
                              onChange={(e) => {
                                const file = e.target.files?.[0] ?? null;
                                setFiles((m) => ({ ...m, [label]: file }));
                              }}
                              data-testid={`file-input-${label}`}
                            />
                          </label>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* Inline missing-fields error (shown after Suivant click) */}
          {showErrors && currentMissing.length > 0 && (
            <Alert variant="destructive" data-testid="missing-fields-alert">
              <AlertDescription>
                <div className="font-semibold">Champs obligatoires manquants :</div>
                <ul className="mt-1 list-disc pl-5 text-sm">
                  {currentMissing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

        </CardContent>
      </Card>

      {/* Navigation */}
      <div className="flex justify-between">
        <Button
          variant="outline"
          onClick={handlePrev}
          disabled={step === 1 || submitting}
          data-testid="button-prev-step"
        >
          <ArrowLeft className="mr-2 h-4 w-4" /> Précédent
        </Button>

        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleSaveAsServerDraft}
            disabled={submitting}
            data-testid="button-save-draft"
          >
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Enregistrer en tant que brouillon
          </Button>

          {step < TOTAL_STEPS ? (
            <Button
              onClick={handleNext}
              data-testid="button-next-step"
            >
              Suivant <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          ) : (
            <Button
              onClick={onSubmit}
              disabled={submitting}
              data-testid="button-submit"
            >
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Créer la demande
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
