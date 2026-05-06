import { useState, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, ArrowRight, Loader2, ClipboardList, Upload, FileText, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
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
];

const DATA_TYPES = [
  "Données de santé (PHI)",
  "Données personnelles (PII)",
  "Données critiques (financières, IT, etc.)",
  "Autres données du CHdN",
];

const REQUIRED_DOCS = [
  "Offre de prix",
  "Offre de prix des consommables",
  "Offre de prix pour formation",
  "Offre de prix pour la maintenance",
  "Documentation contractuelle (SLA, CGV, maintenance, etc.)",
  "Fiche technique",
  "Manuel d'utilisation",
  "Certificat CE (si équipement médical ou hardware)",
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

function CheckboxList({
  options,
  values,
  onChange,
}: {
  options: string[];
  values: string[];
  onChange: (v: string[]) => void;
}) {
  function toggle(opt: string) {
    if (values.includes(opt)) onChange(values.filter((v) => v !== opt));
    else onChange([...values, opt]);
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((opt) => (
        <div key={opt} className="flex items-start space-x-2">
          <Checkbox
            id={`cb-${opt}`}
            checked={values.includes(opt)}
            onCheckedChange={() => toggle(opt)}
          />
          <Label htmlFor={`cb-${opt}`} className="cursor-pointer font-normal leading-snug">
            {opt}
          </Label>
        </div>
      ))}
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
  const [documentsProvided, setDocumentsProvided] = useState<string[]>([]);

  // ── Step 7 – uploads, one per checked item in section 11 ──────
  const [files, setFiles] = useState<Record<string, File | null>>({});

  // Default the department selector to the first one once departments
  // load — the user can change it but this avoids an empty required.
  useEffect(() => {
    if (!departmentId && departments && departments.length > 0) {
      setDepartmentId(String(departments[0].id));
    }
  }, [departments, departmentId]);

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
    supplierCompanyId ? Number(supplierCompanyId) : 0,
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
      exceptionJustification: exceptionJustification || null,
      budgetPositionKnown: budgetPositionKnown || null,
      budgetPosition: budgetPosition || null,
      supplierName: supplierCompany?.name ?? null,
      supplierContact: supplierContact
        ? [supplierContact.name, supplierContact.email, supplierContact.phone]
            .filter(Boolean)
            .join(" · ")
        : null,
      supplierCompanyId: supplierCompany?.id ?? null,
      supplierContactId: supplierContact?.id ?? null,
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
    };
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
      if (!supplierContactId) m.push("5.2 Personne de contact");
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
        if (!files[d]) m.push(`Fichier pour « ${d} »`);
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
      const wf: Workflow = await create.mutateAsync({
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

      // Upload every checked document. Multipart fetch directly — the
      // codegen client also exposes UploadWorkflowDocumentBodyTwo for
      // multipart, but a plain fetch is simpler than juggling the
      // generated discriminator.
      let offrePrixDocId: number | null = null;
      for (const label of documentsProvided) {
        const file = files[label];
        if (!file) continue;
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
        const company = (companies ?? []).find(
          (c) => String(c.id) === supplierCompanyId,
        );
        await update.mutateAsync({
          id: wf.id,
          data: {
            quotes: [
              {
                companyId: Number(supplierCompanyId),
                companyName: company?.name ?? null,
                contactId: supplierContactId
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

      qc.invalidateQueries();
      setLocation(`/workflows/${wf.id}`);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Création impossible",
        description: extractApiError(err, "La commande n'a pas pu être créée."),
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
              <SectionTitle number="0" label="Commande" />
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
                        {Object.values(Priority).map((p) => (
                          <SelectItem key={p} value={p}>
                            {p}
                          </SelectItem>
                        ))}
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
                      <YesNoSelect value={livreIException} onChange={(v) => {
                        setLivreIException(v);
                        setExceptionJustification("");
                      }} />
                    </div>
                    {livreIException === "false" && (
                      <p className="text-xs text-amber-600">
                        Besoin de 3 Offres, voir import après création de la demande.
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
                        <p className="text-xs text-amber-600">
                          Veuillez contacter le service juridique.
                        </p>
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
                      <YesNoSelect value={livreIIException} onChange={(v) => {
                        setLivreIIException(v);
                        setExceptionJustification("");
                      }} />
                    </div>
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
                        <p className="text-xs text-amber-600">
                          Veuillez contacter le service juridique.
                        </p>
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
                    <Select value={supplierCompanyId} onValueChange={setSupplierCompanyId}>
                      <SelectTrigger data-testid="select-supplier-company">
                        <SelectValue placeholder="Sélectionner un fournisseur..." />
                      </SelectTrigger>
                      <SelectContent className="max-h-64">
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
                  )}
                </div>
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
              </div>

              <SectionTitle number="6" label="Aspects techniques et infrastructure" />
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>6.1 Aménagements architecturaux ou techniques nécessaires ?<Req /></Label>
                    <YesNoSelect value={architecturalWorks} onChange={setArchitecturalWorks} />
                    {architecturalWorks === "true" && (
                      <p className="text-xs text-amber-600">
                        Contacter le service technique.
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
                    <Label>6.3.1 Type d'accès<Req /></Label>
                    <CheckboxList
                      options={ACCESS_TYPES}
                      values={accessTypes}
                      onChange={setAccessTypes}
                    />
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
                    <p className="text-xs text-amber-600">Validation DPO requise.</p>
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
                      Validation du service PP requise.
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
                      <p className="text-xs text-amber-600">Contacter le service hygiène.</p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label>9.5 Stérilisation requise ?<Req /></Label>
                    <YesNoSelect value={sterilizationRequired} onChange={setSterilizationRequired} />
                    {sterilizationRequired === "true" && (
                      <p className="text-xs text-amber-600">Contacter le service stérilisation.</p>
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
                  <Input
                    id="commissioningDate"
                    type="date"
                    value={commissioningDate}
                    onChange={(e) => setCommissioningDate(e.target.value)}
                    data-testid="input-neededby"
                  />
                </div>
              </div>

              <SectionTitle number="11" label="Documentation obligatoire à fournir" />
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Cocher les documents qui seront joints. Vous pourrez les téléverser à l'étape suivante.<Req />
                </p>
                <CheckboxList
                  options={REQUIRED_DOCS}
                  values={documentsProvided}
                  onChange={(v) => {
                    setDocumentsProvided(v);
                    // Drop any file selection for items that were just unchecked.
                    setFiles((f) => {
                      const next: Record<string, File | null> = {};
                      for (const k of v) next[k] = f[k] ?? null;
                      return next;
                    });
                  }}
                />
              </div>
            </>
          )}

          {/* ── STEP 7 — uploads for every checked Section 11 doc ── */}
          {step === 7 && (
            <>
              <SectionTitle number="12" label="Téléversement des documents" />
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
            Créer la commande
          </Button>
        )}
      </div>
    </div>
  );
}
