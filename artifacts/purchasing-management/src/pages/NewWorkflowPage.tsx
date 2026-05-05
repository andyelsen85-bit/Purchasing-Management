import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, ArrowRight, Loader2, ClipboardList } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
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
  Priority,
  type InvestmentForm,
} from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { extractApiError } from "@/lib/api-error";

const TOTAL_STEPS = 6;

const STEP_LABELS = [
  "Identification",
  "Description du besoin",
  "Nature & Financiers",
  "Fournisseur & Technique",
  "Données & Consommables",
  "Maintenance & Formation",
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
  "Offre de prix pour la maintenance",
  "Documentation contractuelle (SLA, CGV, maintenance, etc.)",
  "Fiche technique",
  "Manuel d'utilisation",
  "Certificat CE (si équipement médical ou hardware)",
  "Certificat de résistance au feu (si mobilier ou matériel inflammable)",
  "Normes ISO 80601 et/ou IEC 60601 (pour matériel roulant)",
];

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

export function NewWorkflowPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { data: departments } = useListDepartments();
  const { toast } = useToast();

  const [step, setStep] = useState(1);

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
  const [exceptionProcedure, setExceptionProcedure] = useState("");
  const [exceptionJustification, setExceptionJustification] = useState("");
  const [budgetPositionKnown, setBudgetPositionKnown] = useState("");
  const [budgetPosition, setBudgetPosition] = useState("");

  // ── Section 5 – Fournisseur ────────────────────────────────────
  const [supplierName, setSupplierName] = useState("");
  const [supplierContact, setSupplierContact] = useState("");

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

  // ── Section 11 – Documentation ────────────────────────────────
  const [documentsProvided, setDocumentsProvided] = useState<string[]>([]);

  useEffect(() => {
    if (!departmentId && departments && departments.length > 0) {
      setDepartmentId(String(departments[0].id));
    }
  }, [departments, departmentId]);

  const create = useCreateWorkflow({
    mutation: {
      onSuccess: (wf) => {
        qc.invalidateQueries();
        setLocation(`/workflows/${wf.id}`);
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "Cannot create workflow",
          description: extractApiError(err, "Could not create workflow."),
        });
      },
    },
  });

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
      exceptionProcedure: exceptionProcedure || null,
      exceptionJustification: exceptionJustification || null,
      budgetPositionKnown: budgetPositionKnown || null,
      budgetPosition: budgetPosition || null,
      supplierName: supplierName || null,
      supplierContact: supplierContact || null,
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

  function canAdvance(): boolean {
    if (step === 1 && (!title.trim() || !departmentId)) return false;
    return true;
  }

  function onSubmit() {
    if (!title || !departmentId) return;
    create.mutate({
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

  const progressPct = ((step - 1) / TOTAL_STEPS) * 100;

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
              Informations de base sur la demande et le projet.
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
        </CardHeader>
        <CardContent className="space-y-6">

          {/* ── STEP 1 ─────────────────────────────────────────────── */}
          {step === 1 && (
            <>
              <SectionTitle number="0" label="Workflow" />
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="title">Titre du workflow *</Label>
                  <Input
                    id="title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="ex. Acquisition scanner IRM"
                    required
                    data-testid="input-title"
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Service / Département *</Label>
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
                <div className="space-y-1.5">
                  <Label htmlFor="category">Catégorie</Label>
                  <Input
                    id="category"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="ex. Matériel médical"
                    data-testid="input-category"
                  />
                </div>
              </div>

              <SectionTitle number="1" label="Identification générale" />
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="projectLeader">1.3 Responsable / Leader du projet</Label>
                  <Input
                    id="projectLeader"
                    value={projectLeader}
                    onChange={(e) => setProjectLeader(e.target.value)}
                    data-testid="input-project-leader"
                  />
                </div>
                <div className="space-y-2">
                  <Label>1.4 Type d'investissement (cocher les cases appropriées)</Label>
                  <CheckboxList
                    options={INVESTMENT_TYPES}
                    values={investmentTypes}
                    onChange={setInvestmentTypes}
                  />
                  {investmentTypes.includes("Autre") && (
                    <Input
                      placeholder="Préciser..."
                      value={investmentTypeOther}
                      onChange={(e) => setInvestmentTypeOther(e.target.value)}
                      className="mt-2"
                    />
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
                    2.1 Description détaillée de l'équipement / investissement
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
                    2.2 Argumentaire – justification de l'investissement
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
                  <Label>2.3 L'équipement a-t-il déjà été testé en Demo au CHdN ?</Label>
                  <YesNoSelect value={demoTested} onChange={setDemoTested} />
                </div>
                {demoTested === "true" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="demoContext">Préciser le contexte du test</Label>
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
                  <Label>3.1 Nature de la demande</Label>
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
                      <Label>3.1.1 Numéro d'équipement / numéro de série ou nom remplacé</Label>
                      <Input
                        value={replacedEquipmentRef}
                        onChange={(e) => setReplacedEquipmentRef(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>3.1.2 Localisation de l'équipement existant</Label>
                      <Input
                        value={replacedEquipmentLocation}
                        onChange={(e) => setReplacedEquipmentLocation(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>3.1.3 Motif du remplacement</Label>
                      <Textarea
                        rows={2}
                        value={replacementReason}
                        onChange={(e) => setReplacementReason(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>3.1.4 L'ancien équipement sera-t-il mis hors service ?</Label>
                      <YesNoSelect value={decommissioned} onChange={setDecommissioned} />
                    </div>
                    {decommissioned === "false" && (
                      <div className="space-y-1.5">
                        <Label>Préciser ce qu'il deviendra</Label>
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
                    4.1 Coût total estimé sur 5 années (HTVA)
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Inclure : achat, maintenance, consommables, formation, abonnements.
                  </p>
                  <Input
                    id="amount5y"
                    type="number"
                    step="0.01"
                    value={estimatedAmount5y}
                    onChange={(e) => setEstimatedAmount5y(e.target.value)}
                    placeholder="Montant total HTVA"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>4.3 La demande relève-t-elle d'une procédure d'exception ?</Label>
                  <Select value={exceptionProcedure} onValueChange={setExceptionProcedure}>
                    <SelectTrigger>
                      <SelectValue placeholder="Sélectionner..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NONE">Non</SelectItem>
                      <SelectItem value="LIVRE_I">
                        Oui – Livre I (marchés au-dessous des seuils européens)
                      </SelectItem>
                      <SelectItem value="LIVRE_II">
                        Oui – Livre II (marchés au-dessus des seuils européens)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {(exceptionProcedure === "LIVRE_I" || exceptionProcedure === "LIVRE_II") && (
                  <div className="space-y-1.5">
                    <Label>4.3.1 Justification détaillée de la procédure d'exception</Label>
                    <Textarea
                      rows={3}
                      value={exceptionJustification}
                      onChange={(e) => setExceptionJustification(e.target.value)}
                    />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label>4.4 La position budgétaire est-elle connue ?</Label>
                  <Select value={budgetPositionKnown} onValueChange={setBudgetPositionKnown}>
                    <SelectTrigger>
                      <SelectValue placeholder="Sélectionner..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="YES">Oui</SelectItem>
                      <SelectItem value="NO">Non</SelectItem>
                      <SelectItem value="TO_CONFIRM">À confirmer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {budgetPositionKnown && (
                  <div className="space-y-1.5">
                    <Label>4.4.1 Position budgétaire (selon liste GT Invest)</Label>
                    <Input
                      value={budgetPosition}
                      onChange={(e) => setBudgetPosition(e.target.value)}
                    />
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
                  <Label>5.1 Nom du fournisseur</Label>
                  <Input
                    value={supplierName}
                    onChange={(e) => setSupplierName(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>5.2 Personne de contact (nom, e-mail, téléphone)</Label>
                  <Input
                    value={supplierContact}
                    onChange={(e) => setSupplierContact(e.target.value)}
                    placeholder="Nom, email, tél."
                  />
                </div>
              </div>

              <SectionTitle number="6" label="Aspects techniques et infrastructure" />
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>6.1 Aménagements architecturaux ou techniques nécessaires ?</Label>
                    <YesNoSelect value={architecturalWorks} onChange={setArchitecturalWorks} />
                    {architecturalWorks === "true" && (
                      <p className="text-xs text-amber-600">
                        Contacter le service technique.
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label>6.2 Connexion informatique requise ?</Label>
                    <YesNoSelect value={itConnection} onChange={setItConnection} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>
                    6.3 Accès ou interopérabilité avec des systèmes critiques (DPI, IT…) ?
                  </Label>
                  <Select value={systemInterop} onValueChange={setSystemInterop}>
                    <SelectTrigger>
                      <SelectValue placeholder="Sélectionner..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">Oui</SelectItem>
                      <SelectItem value="false">Non</SelectItem>
                      <SelectItem value="unknown">Ne sais pas</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>6.4 Type d'accès (si applicable)</Label>
                  <CheckboxList
                    options={ACCESS_TYPES}
                    values={accessTypes}
                    onChange={setAccessTypes}
                  />
                </div>
              </div>
            </>
          )}

          {/* ── STEP 5 ─────────────────────────────────────────────── */}
          {step === 5 && (
            <>
              <SectionTitle number="7" label="Données, sécurité et conformité" />
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>7.1 L'équipement / la solution traite-t-il ou donne-t-il accès à :</Label>
                  <CheckboxList
                    options={DATA_TYPES}
                    values={dataTypes}
                    onChange={setDataTypes}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>7.2 Impact potentiel en cas d'indisponibilité du système</Label>
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
                  <Label>7.3 L'offre inclut-elle de l'intelligence artificielle ?</Label>
                  <YesNoSelect value={hasAI} onChange={setHasAI} />
                  {hasAI === "true" && (
                    <p className="text-xs text-amber-600">Validation DPO requise.</p>
                  )}
                </div>
              </div>

              <SectionTitle number="8" label="Consommables et sécurité" />
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label>8.1 Des consommables sont-ils nécessaires (EPI inclus) ?</Label>
                  <YesNoSelect value={consumablesNeeded} onChange={setConsumablesNeeded} />
                </div>
                {consumablesNeeded === "true" && (
                  <div className="space-y-1.5">
                    <Label>8.2 Offre des consommables jointe ?</Label>
                    <YesNoSelect
                      value={consumablesOfferAttached}
                      onChange={setConsumablesOfferAttached}
                    />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label>8.3 Les consommables incluent-ils des gaz ou produits chimiques ?</Label>
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
                  <Label>9.1 Durée de la garantie</Label>
                  <Input
                    value={warrantyDuration}
                    onChange={(e) => setWarrantyDuration(e.target.value)}
                    placeholder="ex. 2 ans"
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label>9.2 Contrat de maintenance nécessaire ?</Label>
                    <YesNoSelect value={maintenanceContract} onChange={setMaintenanceContract} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>9.4 Nettoyage / désinfection requis ?</Label>
                    <YesNoSelect value={cleaningRequired} onChange={setCleaningRequired} />
                    {cleaningRequired === "true" && (
                      <p className="text-xs text-amber-600">Contacter le service hygiène.</p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label>9.5 Stérilisation requise ?</Label>
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
                  <Label>10.1 Une formation pour les utilisateurs est-elle nécessaire ?</Label>
                  <YesNoSelect value={trainingRequired} onChange={setTrainingRequired} />
                </div>
                {trainingRequired === "true" && (
                  <div className="space-y-1.5">
                    <Label>10.1.1 Offre de formation jointe ?</Label>
                    <YesNoSelect
                      value={trainingOfferAttached}
                      onChange={setTrainingOfferAttached}
                    />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="commissioningDate">
                    10.2 Date souhaitée de mise en production / service
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
                  Cocher les documents déjà fournis ou qui seront joints.
                </p>
                <CheckboxList
                  options={REQUIRED_DOCS}
                  values={documentsProvided}
                  onChange={setDocumentsProvided}
                />
              </div>
            </>
          )}

        </CardContent>
      </Card>

      {/* Navigation */}
      <div className="flex justify-between">
        <Button
          variant="outline"
          onClick={() => setStep((s) => Math.max(1, s - 1))}
          disabled={step === 1}
          data-testid="button-prev-step"
        >
          <ArrowLeft className="mr-2 h-4 w-4" /> Précédent
        </Button>

        {step < TOTAL_STEPS ? (
          <Button
            onClick={() => setStep((s) => s + 1)}
            disabled={!canAdvance()}
            data-testid="button-next-step"
          >
            Suivant <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        ) : (
          <Button
            onClick={onSubmit}
            disabled={create.isPending || !title || !departmentId}
            data-testid="button-submit"
          >
            {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Créer le workflow
          </Button>
        )}
      </div>
    </div>
  );
}
