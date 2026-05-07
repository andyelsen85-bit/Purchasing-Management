import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  ArrowLeft,
  ArrowRight,
  Undo2,
  FileText,
  MessageSquare,
  History,
  Plus,
  Trash2,
  Loader2,
  Upload,
  Download,
  Save,
  AlertCircle,
  CheckCircle2,
  ClipboardList,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  useGetWorkflow,
  useListWorkflowDocuments,
  useListWorkflowNotes,
  useListWorkflowHistory,
  useListCompanies,
  useListGtInvestDates,
  useSetGtInvestDecision,
  useUpdateWorkflow,
  useAdvanceWorkflow,
  useRejectWorkflow,
  useUndoWorkflow,
  useDeleteWorkflow,
  useUploadWorkflowDocument,
  useDeleteDocument,
  useCreateWorkflowNote,
  useGetSettings,
  AdvanceWorkflowInputBranch,
  UploadDocumentInputKind,
  getGetWorkflowQueryKey,
  getListWorkflowDocumentsQueryKey,
  type Workflow,
  type QuoteEntry,
  type InvestmentForm,
} from "@/lib/api";
import { StepProgress } from "@/components/StepProgress";
import { STEP_LABEL, type Step, fileToBase64, formatBytes } from "@/lib/steps";
import { fmtDate as fmtDateUtil, fmtDateTime as fmtDateTimeUtil } from "@/lib/date";
import { GT_DECISION_OPTIONS, gtDecisionLabel } from "@/pages/GtInvestPage";
import {
  MissingFieldsProvider,
  RequiredMark,
  missingInputCls,
  useMissingFields,
} from "@/components/MissingFields";
import { computeMissingFields } from "@/lib/workflowValidation";
import type { SessionUser } from "@/components/AuthGate";
import { useToast } from "@/hooks/use-toast";
import { extractErrorMessage } from "@/lib/utils";

interface Props {
  id: number;
  user: SessionUser;
}

export function WorkflowDetailPage({ id, user }: Props) {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const wfQuery = useGetWorkflow(id);
  const wf = wfQuery.data as Workflow | undefined;

  if (wfQuery.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!wf) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Commande introuvable.</AlertDescription>
        </Alert>
      </div>
    );
  }

  function refresh() {
    qc.invalidateQueries();
  }

  return (
    <MissingFieldsProvider>
    <div className="space-y-6 p-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setLocation("/workflows")}
        data-testid="button-back"
      >
        <ArrowLeft className="mr-2 h-4 w-4" /> Retour aux commandes
      </Button>

      <div className="flex items-start justify-between gap-4">
        <div>
          <div
            className="font-mono text-xs text-muted-foreground"
            data-testid="text-reference"
          >
            {wf.reference}
          </div>
          <h1
            className="mt-1 text-2xl font-semibold"
            data-testid="text-page-title"
          >
            {wf.title}
          </h1>
          <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
            <span>{wf.departmentName}</span>
            <span>·</span>
            <span>{wf.createdByName}</span>
            <Badge variant="outline">{wf.priority}</Badge>
            {(() => {
              // Publication tier badge — falls back to threeQuoteRequired
              // for rows created before the tier column existed.
              const tier =
                (wf as { publicationTier?: string | null }).publicationTier ??
                (wf.threeQuoteRequired ? "THREE_QUOTES" : "STANDARD");
              if (tier === "STANDARD") return null;
              const label =
                tier === "LIVRE_II"
                  ? "Livre II"
                  : tier === "LIVRE_I"
                    ? "Livre I"
                    : "3 quotes";
              const tone =
                tier === "LIVRE_II"
                  ? "bg-purple-100 text-purple-800 border-purple-200"
                  : tier === "LIVRE_I"
                    ? "bg-amber-100 text-amber-800 border-amber-200"
                    : "bg-blue-100 text-blue-800 border-blue-200";
              return (
                <Badge
                  variant="outline"
                  className={tone}
                  data-testid="badge-publication-tier"
                >
                  {label}
                </Badge>
              );
            })()}
          </div>
        </div>
        <ActionBar wf={wf} user={user} onChange={refresh} />
      </div>

      <Card>
        <CardContent className="p-5">
          <StepProgress current={wf.currentStep} branch={wf.branch} />
        </CardContent>
      </Card>

      <Tabs defaultValue="step" className="space-y-4">
        <TabsList>
          <TabsTrigger value="step" data-testid="tab-step">
            Principal
          </TabsTrigger>
          <TabsTrigger value="summary" data-testid="tab-summary">
            Récapitulatif
          </TabsTrigger>
          <TabsTrigger value="form" data-testid="tab-form">
            <ClipboardList className="mr-1 h-3.5 w-3.5" /> Formulaire
          </TabsTrigger>
          <TabsTrigger value="docs" data-testid="tab-documents">
            <FileText className="mr-1 h-3.5 w-3.5" /> Documents
          </TabsTrigger>
          <TabsTrigger value="notes" data-testid="tab-notes">
            <MessageSquare className="mr-1 h-3.5 w-3.5" /> Notes
          </TabsTrigger>
          <TabsTrigger value="history" data-testid="tab-history">
            <History className="mr-1 h-3.5 w-3.5" /> Historique
          </TabsTrigger>
        </TabsList>

        <TabsContent value="step">
          <StepPanel wf={wf} user={user} onChange={refresh} />
        </TabsContent>
        <TabsContent value="summary">
          {/* Always-on prior-steps recap, regardless of current step.
              Shows everything completed before the current step plus
              the merged-PDF export link. */}
          <Card>
            <CardContent className="p-5">
              <PriorStepsRecap wf={wf} throughStep={wf.currentStep as Step} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="form">
          <InvestmentFormPanel wf={wf} />
        </TabsContent>
        <TabsContent value="docs">
          <DocumentsPanel wf={wf} />
        </TabsContent>
        <TabsContent value="notes">
          <NotesPanel wf={wf} />
        </TabsContent>
        <TabsContent value="history">
          <HistoryPanel wf={wf} />
        </TabsContent>
      </Tabs>
    </div>
    </MissingFieldsProvider>
  );
}

function ActionBar({
  wf,
  user,
  onChange,
}: {
  wf: Workflow;
  user: SessionUser;
  onChange: () => void;
}) {
  const [branch, setBranch] = useState<keyof typeof AdvanceWorkflowInputBranch | "">("");
  const { setMissing, runBeforeAdvance } = useMissingFields();
  const { data: docs } = useListWorkflowDocuments(wf.id);
  const qc = useQueryClient();
  const advance = useAdvanceWorkflow({
    mutation: {
      onSuccess: () => {
        setMissing(new Set());
        onChange();
      },
      onError: (err) => {
        // Server-side validation may still flag fields the client
        // didn't catch (e.g. a stale doc list). Re-run the local
        // checker so the user still gets visual highlights instead
        // of just a console error. We *intentionally* swallow the
        // error message here — the user asked for highlights only,
        // no popup.
        const missing = computeMissingFields(
          wf,
          (docs ?? []).map((d) => ({
            kind: d.kind,
            isCurrent: (d as unknown as { isCurrent?: boolean }).isCurrent,
          })),
          branch ? branch : null,
        );
        setMissing(missing);
        void err;
      },
    },
  });
  const undo = useUndoWorkflow({
    mutation: {
      onSuccess: () => onChange(),
      onError: (err) => {
        const msg =
          (err as { data?: { message?: string } }).data?.message ??
          (err as Error).message;
        alert(`Cannot undo: ${msg}`);
      },
    },
  });
  // Soft-delete: admin-only. Sends the workflow to the trash (visible
  // and restorable from Settings → Trash). After success we navigate
  // back to the workflows list since the current detail page is now
  // hidden by every list query (they all filter `deletedAt IS NULL`).
  const [, navigate] = useLocation();
  const del = useDeleteWorkflow({
    mutation: {
      onSuccess: () => {
        onChange();
        navigate("/");
      },
      onError: (err) => {
        const msg =
          (err as { data?: { message?: string } }).data?.message ??
          (err as Error).message;
        alert(`Cannot delete: ${msg}`);
      },
    },
  });

  // Close the workflow from any non-terminal step. The server enforces
  // the "any non-terminal" rule so the client mirrors it. Includes the
  // step-specific approval-panel reject buttons but is also available
  // here on every step (Quotation, Ordering, Delivery, Invoice, etc.).
  const reject = useRejectWorkflow({
    mutation: {
      onSuccess: () => onChange(),
      onError: (err) => {
        const msg =
          (err as { data?: { message?: string } }).data?.message ??
          (err as Error).message;
        alert(`Cannot close: ${msg}`);
      },
    },
  });
  const canUndo =
    user.roles.includes("ADMIN") || user.roles.includes("FINANCIAL_ALL");
  const canDelete = user.roles.includes("ADMIN");
  // The branch picker AND the advance button are both moved INTO the
  // Financial Approval panel for VALIDATING_BY_FINANCIAL — that step
  // bundles "approve + route" into a single inline action, so we hide
  // the global Advance control here to avoid two ways to do the same
  // thing (and to prevent advancing without picking a branch).
  const inlineAdvanceStep = wf.currentStep === "VALIDATING_BY_FINANCIAL";
  const isTerminal =
    wf.currentStep === "DONE" || wf.currentStep === "REJECTED";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!inlineAdvanceStep && (
        <Button
          onClick={async () => {
            // First, persist any unsaved local form edits the user
            // made on the current step's form. Each step panel
            // registers a save callback via the MissingFields
            // context; awaiting it ensures the freshly-typed values
            // reach the server before we re-check prerequisites.
            try {
              await runBeforeAdvance();
            } catch {
              // The save itself surfaces a "Save failed" toast via
              // useSaveWorkflow; abort the advance silently.
              return;
            }
            // Refetch the workflow + documents so the local missing
            // check sees the just-persisted values rather than the
            // stale snapshot captured in this closure.
            await Promise.all([
              qc.refetchQueries({
                queryKey: getGetWorkflowQueryKey(wf.id),
              }),
              qc.refetchQueries({
                queryKey: getListWorkflowDocumentsQueryKey(wf.id),
              }),
            ]);
            const freshWf =
              (qc.getQueryData(getGetWorkflowQueryKey(wf.id)) as
                | Workflow
                | undefined) ?? wf;
            const freshDocs =
              (qc.getQueryData(getListWorkflowDocumentsQueryKey(wf.id)) as
                | Array<{ kind: string; isCurrent?: boolean }>
                | undefined) ?? docs ?? [];
            // Pre-validate locally and highlight missing fields
            // instead of firing a request that will surface as an
            // error popup. Only call the server when the client-side
            // checks pass — the server still runs the same checks
            // as a safety net.
            const missing = computeMissingFields(
              freshWf,
              freshDocs.map((d) => ({
                kind: d.kind,
                isCurrent: (d as unknown as { isCurrent?: boolean }).isCurrent,
              })),
              branch ? branch : null,
            );
            if (missing.size > 0) {
              setMissing(missing);
              return;
            }
            setMissing(new Set());
            advance.mutate({
              id: freshWf.id,
              data: { branch: branch ? branch : null },
            });
          }}
          disabled={advance.isPending || isTerminal}
          data-testid="button-advance"
        >
          {advance.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <ArrowRight className="mr-2 h-4 w-4" />
          )}
          Étape suivante
        </Button>
      )}
      {!isTerminal && (
        <Button
          variant="outline"
          className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => {
            const reason = window.prompt(
              "Clôturer cette commande ? Vous pouvez saisir une raison facultative.",
              "",
            );
            if (reason === null) return;
            reject.mutate({
              id: wf.id,
              data: { comment: reason.trim() || null },
            });
          }}
          disabled={reject.isPending}
          data-testid="button-close-workflow"
        >
          {reject.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="mr-2 h-4 w-4" />
          )}
          Clôturer
        </Button>
      )}
      {canUndo && (
        <Button
          variant="outline"
          onClick={() => undo.mutate({ id: wf.id })}
          disabled={
            undo.isPending ||
            // Quotation is the new first step (the legacy "NEW" step
            // has been removed) — there is nothing to undo there.
            wf.currentStep === "NEW" ||
            wf.currentStep === "QUOTATION"
          }
          data-testid="button-undo"
        >
          <Undo2 className="mr-2 h-4 w-4" /> Annuler
        </Button>
      )}
      {canDelete && (
        <Button
          variant="outline"
          className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => {
            if (
              !window.confirm(
                "Déplacer cette commande vers la corbeille ? Les admins peuvent la restaurer depuis Paramètres → Corbeille.",
              )
            )
              return;
            del.mutate({ id: wf.id });
          }}
          disabled={del.isPending}
          data-testid="button-delete-workflow"
        >
          {del.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="mr-2 h-4 w-4" />
          )}
          Corbeille
        </Button>
      )}
    </div>
  );
}

// Inline document uploader used by step panels (Ordering, Delivery,
// Invoice). Shows the documents already attached to this workflow
// for the given `kind`, lets the user upload a new one, and lets
// them delete obsolete ones — all without forcing a trip to the
// Documents tab. The upload route auto-versions when a document of
// the same kind already exists, so the previous file is preserved
// in history.
function StepDocumentUploader({
  wf,
  kind,
  step,
  label,
  required = false,
}: {
  wf: Workflow;
  kind: keyof typeof UploadDocumentInputKind;
  step: Step;
  label: string;
  required?: boolean;
}) {
  const { data: docs } = useListWorkflowDocuments(wf.id);
  const upload = useUploadWorkflowDocument();
  const del = useDeleteDocument();
  const qc = useQueryClient();
  const { missing, clearKey } = useMissingFields();
  const fieldKey = `doc:${kind}`;
  const isMissing = required && missing.has(fieldKey);
  // The server returns all versions (incl. demoted ones), with an
  // extra `isCurrent` flag that isn't in the generated OpenAPI type.
  // Filter to current-only via a runtime cast so old versions don't
  // clutter the per-step uploader.
  const matching = (docs ?? [])
    .filter(
      (d) =>
        d.kind === kind &&
        (d as unknown as { isCurrent?: boolean }).isCurrent !== false,
    )
    .sort((a, b) => b.version - a.version);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const base64 = await fileToBase64(f);
      await upload.mutateAsync({
        id: wf.id,
        data: {
          step,
          filename: f.name,
          mimeType: f.type || "application/octet-stream",
          kind,
          contentBase64: base64,
          replacesDocumentId: null,
        },
      });
      // Clear the highlight as soon as the missing doc is provided.
      if (required) clearKey(fieldKey);
    } finally {
      e.target.value = "";
      qc.invalidateQueries();
    }
  }

  return (
    <div
      className={`space-y-2 rounded-md border bg-muted/20 p-3 ${
        isMissing ? "border-destructive ring-1 ring-destructive" : ""
      }`}
    >
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">
          {label}
          {required && <RequiredMark />}
        </Label>
        {upload.isPending && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Chargement…
          </span>
        )}
      </div>
      {matching.length === 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`text-no-doc-${kind}`}
        >
          Aucun fichier joint.
        </p>
      ) : (
        <ul className="space-y-1">
          {matching.map((d) => {
            const href = `/api/documents/${d.id}/download`;
            return (
              <li
                key={d.id}
                className="flex items-center gap-2 text-xs"
                data-testid={`step-doc-${d.id}`}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 truncate hover:underline"
                >
                  {d.filename}
                </a>
                <span className="text-muted-foreground">
                  v{d.version} · {formatBytes(d.sizeBytes)}
                </span>
                <Button
                  asChild
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                >
                  <a href={href} target="_blank" rel="noreferrer">
                    <Download className="h-3 w-3" />
                  </a>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => {
                    if (!confirm(`Delete ${d.filename}?`)) return;
                    del.mutate(
                      { id: d.id },
                      { onSuccess: () => qc.invalidateQueries() },
                    );
                  }}
                  data-testid={`button-step-doc-delete-${d.id}`}
                >
                  <Trash2 className="h-3 w-3 text-destructive" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <Input
        type="file"
        onChange={onPick}
        disabled={upload.isPending}
        data-testid={`input-step-upload-${kind}`}
      />
    </div>
  );
}

function StepPanel({
  wf,
  user,
  onChange,
}: {
  wf: Workflow;
  user: SessionUser;
  onChange: () => void;
}) {
  switch (wf.currentStep) {
    case "QUOTATION":
      return <QuotationPanel wf={wf} onChange={onChange} />;
    case "VALIDATING_QUOTE_FINANCIAL":
      return <ManagerApprovePanel wf={wf} onChange={onChange} />;
    case "VALIDATING_BY_FINANCIAL":
      return <FinancialApprovePanel wf={wf} onChange={onChange} />;
    case "GT_INVEST":
      return <GtInvestPanel wf={wf} onChange={onChange} />;
    case "ORDERING":
      return <OrderingPanel wf={wf} onChange={onChange} />;
    case "DELIVERY":
      return <DeliveryPanel wf={wf} onChange={onChange} />;
    case "INVOICE":
      return <InvoicePanel wf={wf} onChange={onChange} />;
    case "VALIDATING_INVOICE":
      return <InvoiceValidationPanel wf={wf} user={user} onChange={onChange} />;
    case "PAYMENT":
      return <PaymentPanel wf={wf} onChange={onChange} />;
    case "DONE":
      return <DoneSummaryPanel wf={wf} />;
    case "REJECTED":
      return <RejectedPanel wf={wf} />;
    default:
      return (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Step <strong>{STEP_LABEL[wf.currentStep as Step]}</strong>: no
            inline form. Use <em>Advance</em> when ready.
          </CardContent>
        </Card>
      );
  }
}

function DoneSummaryPanel({ wf }: { wf: Workflow }) {
  // Terminal "completed" panel — read-only recap of every field
  // captured across the 9-step workflow plus a flat list of all
  // attached documents (current versions). Mirrors the merged-PDF
  // export on the Validate Invoice step but viewed in-app.
  const { data: docs } = useListWorkflowDocuments(wf.id);
  const { data: dates } = useListGtInvestDates();
  const { data: hist } = useListWorkflowHistory(wf.id);
  const exportHref = `${import.meta.env.BASE_URL}api/workflows/${wf.id}/export-pdf`;

  // Build a `step -> {actor, at}` map for "who completed this step",
  // using the most recent ADVANCE row whose fromStep matches the
  // step. We sort history descending and keep the first hit per
  // fromStep so re-advances after an Undo show the *latest* actor.
  const stepActor = (() => {
    const map = new Map<string, { name: string; at: string }>();
    const sorted = [...(hist ?? [])].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    for (const h of sorted) {
      if (h.action !== "ADVANCE" || !h.fromStep) continue;
      if (!map.has(h.fromStep))
        map.set(h.fromStep, {
          name: h.actorName || "—",
          at: h.createdAt,
        });
    }
    return map;
  })();

  const gtDate = dates?.find((d) => d.id === wf.gtInvestDateId)?.date ?? null;
  const gtResult = gtDecisionLabel(wf.gtInvestDecision);

  const fmtDate = fmtDateUtil;
  const fmtDateTime = fmtDateTimeUtil;
  const fmtMoney = (n: number | null | undefined, _c?: string | null) =>
    n != null ? `${n} €` : "—";
  const fmtBool = (b: boolean | null | undefined) =>
    b == null ? "—" : b ? "Oui" : "Non";
  const orDash = (v: string | null | undefined) => (v && v.length > 0 ? v : "—");

  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="grid grid-cols-[180px_1fr] gap-3 py-1 text-sm">
      <div className="text-muted-foreground">{label}</div>
      <div className="break-words">{value}</div>
    </div>
  );
  const Section = ({
    title,
    step,
    children,
  }: {
    title: string;
    step?: Step;
    children: React.ReactNode;
  }) => {
    const meta = step ? stepActor.get(step) : undefined;
    return (
      <div className="rounded-md border bg-muted/20 p-3">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </div>
          {meta && (
            <div
              className="text-[11px] text-muted-foreground"
              data-testid={`step-actor-${step}`}
            >
              par <span className="font-medium text-foreground">{meta.name}</span>
              {" · "}
              {fmtDateTime(meta.at)}
            </div>
          )}
        </div>
        <div className="divide-y">{children}</div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <Card className="border-emerald-500/40">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-5 w-5" />
            Commande terminée
          </CardTitle>
          <Button asChild variant="outline" size="sm">
            <a
              href={exportHref}
              target="_blank"
              rel="noreferrer"
              data-testid="button-export-pdf-done"
            >
              <Download className="mr-2 h-4 w-4" />
              Exporter PDF groupé
            </a>
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <Section title="Général">
            <Row label="Référence" value={<span className="font-mono">{wf.reference}</span>} />
            <Row label="Titre" value={wf.title} />
            <Row label="Service" value={wf.departmentName} />
            <Row label="Demandé par" value={wf.createdByName} />
            <Row label="Priorité" value={wf.priority} />
            <Row label="Circuit" value={orDash(wf.branch)} />
            <Row label="Description" value={orDash(wf.description)} />
            <Row label="Date souhaitée" value={fmtDate(wf.neededBy)} />
            <Row label="Créé le" value={fmtDateTime(wf.createdAt)} />
            <Row label="Dernière mise à jour" value={fmtDateTime(wf.updatedAt)} />
          </Section>

          <Section title="2 · Offre de prix" step="QUOTATION">
            <Row label="3 offres requises" value={fmtBool(wf.threeQuoteRequired)} />
            <div className="py-1">
              {wf.quotes && wf.quotes.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="px-2 py-1">Fournisseur</th>
                        <th className="px-2 py-1">Montant</th>
                        <th className="px-2 py-1">Notes</th>
                        <th className="px-2 py-1">Retenu</th>
                      </tr>
                    </thead>
                    <tbody>
                      {wf.quotes.map((q, i) => (
                        <tr key={i} className="border-t">
                          <td className="px-2 py-1">{orDash(q.companyName)}</td>
                          <td className="px-2 py-1">{fmtMoney(q.amount)}</td>
                          <td className="px-2 py-1">{orDash(q.notes)}</td>
                          <td className="px-2 py-1">{q.winning ? "★" : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </div>
          </Section>

          <Section
            title="3 · Validation responsable"
            step="VALIDATING_QUOTE_FINANCIAL"
          >
            <Row label="Approuvé" value={fmtBool(wf.managerApproved)} />
            <Row label="Commentaire" value={orDash(wf.managerComment)} />
          </Section>

          <Section
            title="4 · Validation financière"
            step="VALIDATING_BY_FINANCIAL"
          >
            <Row label="Approuvé" value={fmtBool(wf.financialApproved)} />
            <Row label="Commentaire" value={orDash(wf.financialComment)} />
          </Section>

          {wf.branch === "GT_INVEST" || wf.gtInvestDateId || wf.gtInvestResultId ? (
            <Section title="GT Invest" step="GT_INVEST">
              <Row label="Date de réunion" value={fmtDate(gtDate)} />
              <Row label="Résultat" value={orDash(gtResult)} />
              <Row label="Commentaire" value={orDash(wf.gtInvestComment)} />
            </Section>
          ) : null}

          <Section title="5 · Commande" step="ORDERING">
            <Row label="N° de commande" value={orDash(wf.orderNumber)} />
            <Row label="Date de commande" value={fmtDate(wf.orderDate)} />
          </Section>

          <Section title="6 · Livraison" step="DELIVERY">
            <Row label="Livré le" value={fmtDate(wf.deliveredOn)} />
            <Row label="Notes" value={orDash(wf.deliveryNotes)} />
          </Section>

          <Section title="7 · Facture" step="INVOICE">
            <Row label="N° de facture" value={orDash(wf.invoiceNumber)} />
            <Row label="Montant facture" value={fmtMoney(wf.invoiceAmount)} />
            <Row label="Date de facture" value={fmtDate(wf.invoiceDate)} />
          </Section>

          <Section
            title="8 · Validation facture"
            step="VALIDATING_INVOICE"
          >
            <Row label="Validé" value={fmtBool(wf.invoiceValidated)} />
            <Row label="Signé par" value={orDash(wf.invoiceSignedBy)} />
            <Row label="Signé le" value={fmtDateTime(wf.invoiceSignedAt)} />
          </Section>

          <Section title="9 · Paiement" step="PAYMENT">
            <Row label="Date de paiement" value={fmtDate(wf.paymentDate)} />
            <Row label="Référence paiement" value={orDash(wf.paymentReference)} />
          </Section>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Documents ({docs?.length ?? 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {docs && docs.length > 0 ? (
            <ul className="divide-y">
              {docs.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center gap-3 py-2"
                  data-testid={`done-doc-${d.id}`}
                >
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {d.filename}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {d.kind} · v{d.version} · {STEP_LABEL[d.step as Step]} ·{" "}
                      {formatBytes(d.sizeBytes)} · {d.uploadedByName}
                    </div>
                  </div>
                  <Button asChild variant="ghost" size="icon">
                    <a
                      href={`/api/documents/${d.id}/download`}
                      target="_blank"
                      rel="noreferrer"
                      data-testid={`button-done-download-${d.id}`}
                    >
                      <Download className="h-4 w-4" />
                    </a>
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-muted-foreground">
              Aucun document joint.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RejectedPanel({ wf }: { wf: Workflow }) {
  // Terminal closed-by-rejection panel. Surfaces which approval step
  // closed the workflow and the rejection comment recorded there.
  const fromStep = (wf.previousStep as Step | null) ?? null;
  // The close reason is stored on managerComment for the manager
  // approval step, financialComment for everything else (incl. the
  // generic "close workflow" action from a non-approval step).
  const reason =
    fromStep === "VALIDATING_QUOTE_FINANCIAL"
      ? wf.managerComment
      : (wf.financialComment ?? null);
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">
          Commande refusée et clôturée
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div>
          Clôturée à l'étape{" "}
          <strong>
            {fromStep ? STEP_LABEL[fromStep] : "une étape d'approbation"}
          </strong>
          .
        </div>
        {reason ? (
          <div className="rounded-md bg-muted/50 p-3 text-muted-foreground">
            <div className="text-[11px] uppercase tracking-wider">Raison</div>
            <div className="mt-1 whitespace-pre-wrap">{reason}</div>
          </div>
        ) : (
          <div className="text-muted-foreground">
            Aucune raison enregistrée. Un Admin ou Financier-Tous peut annuler pour rouvrir.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function useSaveWorkflow(_wf: Workflow, onChange: () => void) {
  const { toast } = useToast();
  return useUpdateWorkflow({
    mutation: {
      onSuccess: () => {
        onChange();
        toast({ title: "Enregistré", duration: 2000 });
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "Échec de l'enregistrement",
          description: extractErrorMessage(err),
        });
      },
    },
  });
}

function QuotationPanel({
  wf,
  onChange,
}: {
  wf: Workflow;
  onChange: () => void;
}) {
  const { data: companies } = useListCompanies();
  const { data: settings } = useGetSettings();
  const { data: allDocs } = useListWorkflowDocuments(wf.id);
  const upload = useUploadWorkflowDocument();
  const del = useDeleteDocument();
  const qc = useQueryClient();
  const [quotes, setQuotes] = useState<QuoteEntry[]>(
    wf.quotes && wf.quotes.length > 0
      ? wf.quotes
      : [{ winning: false, currency: wf.currency || "EUR", documentIds: [] }],
  );
  const save = useSaveWorkflow(wf, onChange);
  const { setBeforeAdvance } = useMissingFields();
  // Track which row is currently uploading so we can show a spinner
  // and disable the file input. Using a per-row id avoids one global
  // pending flag blocking other rows.
  const [uploadingIdx, setUploadingIdx] = useState<number | null>(null);

  function update(idx: number, patch: Partial<QuoteEntry>) {
    setQuotes((q) => q.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  }
  function addRow() {
    setQuotes((q) => [
      ...q,
      { winning: false, currency: wf.currency || "EUR", documentIds: [] },
    ]);
  }
  function removeRow(idx: number) {
    setQuotes((q) => q.filter((_, i) => i !== idx));
  }
  function setWinning(idx: number) {
    setQuotes((q) => q.map((e, i) => ({ ...e, winning: i === idx })));
  }

  // When three quotes are NOT required (amount below the limit) the
  // single quote is automatically the winning one — there is no
  // selector in the UI. Force-mark the first row as winning when
  // persisting so the server-side WinningQuoteCard and downstream
  // steps see a winner without the user having to click anything.
  function normalizeForSave(rows: QuoteEntry[]): QuoteEntry[] {
    if (threeQuotesRequired) return rows;
    if (rows.length === 0) return rows;
    return rows.map((r, i) => ({ ...r, winning: i === 0 }));
  }

  // 3 quotes required is determined by the investment form's 4.1 estimated
  // amount (estimatedAmount5y), NOT the quote amounts entered in this step.
  // Rule: amount must be in the X–Y band AND 4.1.1 must have been answered
  // "Non" (i.e. exceptionProcedure !== "LIVRE_I").
  const limitX = settings?.limitX ?? null;
  const limitY =
    (settings as { quoteThresholdLivreI?: number | null } | undefined)
      ?.quoteThresholdLivreI ?? null;
  const investmentFormData = wf.investmentForm as
    | { estimatedAmount5y?: number | null; exceptionProcedure?: string | null }
    | null
    | undefined;
  const formAmount = investmentFormData?.estimatedAmount5y ?? null;
  const storedException = investmentFormData?.exceptionProcedure ?? null;
  const threeQuotesRequired =
    limitX != null && formAmount != null
      ? formAmount > limitX &&
        (limitY == null || formAmount <= limitY) &&
        storedException !== "LIVRE_I"
      : wf.threeQuoteRequired;
  // Match the server's predicate in `validateAdvancePrereqs` exactly,
  // otherwise the counter and the advance-gate disagree (off-by-one
  // when a row has `companyName` but no `companyId`, which can happen
  // with legacy / imported quote data).
  const filledCount = quotes.filter(
    (q) => q.amount != null && (q.companyId || q.companyName),
  ).length;

  // Persist current local quote rows on global Next Step so any
  // unsaved row edits are taken into account by the server's
  // advance prerequisites.
  useEffect(() => {
    setBeforeAdvance(async () => {
      await save.mutateAsync({
        id: wf.id,
        data: { quotes: normalizeForSave(quotes) },
      });
    });
    return () => setBeforeAdvance(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setBeforeAdvance, save, wf.id, quotes, threeQuotesRequired]);

  async function onPickQuoteFile(
    idx: number,
    e: React.ChangeEvent<HTMLInputElement>,
  ) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploadingIdx(idx);
    try {
      const base64 = await fileToBase64(f);
      const doc = await upload.mutateAsync({
        id: wf.id,
        data: {
          step: "QUOTATION",
          filename: f.name,
          mimeType: f.type || "application/octet-stream",
          kind: "QUOTE",
          contentBase64: base64,
          replacesDocumentId: null,
        },
      });
      // Persist the linkage immediately so a refresh doesn't lose it
      // (the file already exists in the documents collection at this
      // point, so even if save fails the file isn't orphaned UI-wise).
      const updated = quotes.map((q, i) =>
        i === idx
          ? { ...q, documentIds: [...(q.documentIds ?? []), doc.id] }
          : q,
      );
      setQuotes(updated);
      save.mutate({ id: wf.id, data: { quotes: normalizeForSave(updated) } });
    } finally {
      setUploadingIdx(null);
      e.target.value = "";
      qc.invalidateQueries();
    }
  }

  function detachDoc(idx: number, docId: number) {
    const updated = quotes.map((q, i) =>
      i === idx
        ? {
            ...q,
            documentIds: (q.documentIds ?? []).filter((id) => id !== docId),
          }
        : q,
    );
    setQuotes(updated);
    // Detach in DB first, then delete the file. The document record
    // is shared between the quotes JSON and the documents table, so
    // deleting the file is the cleanest way to fully remove it.
    save.mutate(
      { id: wf.id, data: { quotes: normalizeForSave(updated) } },
      {
        onSuccess: () =>
          del.mutate(
            { id: docId },
            { onSettled: () => qc.invalidateQueries() },
          ),
      },
    );
  }

  const { missing } = useMissingFields();
  const quotesMissing =
    missing.has("quotes") ||
    missing.has("quotes-winning") ||
    missing.has("doc:QUOTE");

  return (
    <div className="space-y-4">
      {/* Request brief — surfaces the fields formerly captured in the
          retired "1 · New request" step (description / category /
          needed-by) at the top of the Main tab so a request landing in
          QUOTATION still shows the original ask up-front. */}
      <Card>
        <CardHeader>
          <CardTitle>Contexte de la demande</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div>
            <div className="text-xs text-muted-foreground">Description</div>
            <div>{wf.description && wf.description.length > 0 ? wf.description : "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Date souhaitée</div>
            <div>{wf.neededBy ? fmtDateUtil(wf.neededBy) : "—"}</div>
          </div>
        </CardContent>
      </Card>
    <Card
      className={
        quotesMissing ? "border-destructive ring-1 ring-destructive" : ""
      }
    >
      <CardHeader>
        <CardTitle>
          Offres de prix{quotesMissing && <RequiredMark />}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {threeQuotesRequired
            ? "Collectez les offres de prix des fournisseurs. Marquez l'une comme retenue avant de continuer."
            : "Le montant est en dessous du seuil — une seule offre suffit et est automatiquement retenue."}
        </p>
        {threeQuotesRequired && (
          <Alert className="mt-2 border-amber-500/50 text-amber-700 dark:text-amber-400 [&>svg]:text-amber-600">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              La première offre
              {limitX != null ? (
                <>
                  {" "}dépasse le seuil configuré de{" "}
                  <strong>
                    {limitX} €
                  </strong>
                </>
              ) : (
                <> dépasse le seuil configuré</>
              )}
              . Veuillez collecter <strong>trois offres</strong> de fournisseurs différents avant de continuer ({filledCount}/3 saisies).
            </AlertDescription>
          </Alert>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {quotes.map((q, idx) => (
          <div
            key={idx}
            className="grid grid-cols-12 items-end gap-2 rounded-md border p-3"
            data-testid={`row-quote-${idx}`}
          >
            <div className="col-span-4 space-y-1">
              <Label className="text-xs">Fournisseur</Label>
              <Select
                value={q.companyId ? String(q.companyId) : ""}
                onValueChange={(v) => {
                  const c = companies?.find((cc) => cc.id === Number(v));
                  update(idx, {
                    companyId: Number(v),
                    companyName: c?.name ?? null,
                  });
                }}
              >
                <SelectTrigger data-testid={`select-supplier-${idx}`}>
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {(companies ?? []).map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-5 space-y-1">
              <Label className="text-xs">Montant (€)</Label>
              <Input
                type="number"
                step="0.01"
                value={q.amount ?? ""}
                onChange={(e) =>
                  update(idx, {
                    amount: e.target.value ? Number(e.target.value) : null,
                  })
                }
                data-testid={`input-amount-${idx}`}
              />
            </div>
            <div className="col-span-2 space-y-1">
              <Label className="text-xs">Retenu</Label>
              {threeQuotesRequired ? (
                <Button
                  type="button"
                  variant={q.winning ? "default" : "outline"}
                  className="w-full"
                  size="sm"
                  onClick={() => setWinning(idx)}
                  data-testid={`button-winning-${idx}`}
                >
                  {q.winning ? "Sélectionné" : "Choisir"}
                </Button>
              ) : (
                <div
                  className="flex h-9 w-full items-center justify-center rounded-md border bg-muted/50 text-xs text-muted-foreground"
                  data-testid={`text-winning-auto-${idx}`}
                >
                  {idx === 0 ? "Retenu" : "—"}
                </div>
              )}
            </div>
            <div className="col-span-1 flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeRow(idx)}
                data-testid={`button-remove-${idx}`}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
            <div className="col-span-12 space-y-1">
              <Label className="text-xs">Notes</Label>
              <Input
                value={q.notes ?? ""}
                onChange={(e) => update(idx, { notes: e.target.value })}
                data-testid={`input-notes-${idx}`}
              />
            </div>
            <div className="col-span-12 space-y-2 border-t pt-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Documents de l'offre</Label>
                <div className="flex items-center gap-2">
                  {uploadingIdx === idx && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> Chargement…
                    </span>
                  )}
                  <Label
                    htmlFor={`quote-file-${idx}`}
                    className="inline-flex cursor-pointer items-center gap-1 rounded border bg-background px-2 py-1 text-xs hover:bg-muted"
                    data-testid={`button-upload-quote-${idx}`}
                  >
                    <Upload className="h-3 w-3" /> Joindre un fichier
                  </Label>
                  <input
                    id={`quote-file-${idx}`}
                    type="file"
                    className="hidden"
                    disabled={uploadingIdx === idx}
                    onChange={(e) => onPickQuoteFile(idx, e)}
                    data-testid={`input-file-quote-${idx}`}
                  />
                </div>
              </div>
              {(() => {
                const ids = q.documentIds ?? [];
                if (ids.length === 0)
                  return (
                    <p className="text-xs text-muted-foreground">
                      Aucun fichier joint.
                    </p>
                  );
                return (
                  <ul className="space-y-1">
                    {ids.map((docId) => {
                      const d = (allDocs ?? []).find((x) => x.id === docId);
                      const href = `/api/documents/${docId}/download`;
                      return (
                        <li
                          key={docId}
                          className="flex items-center gap-2 rounded border bg-muted/30 px-2 py-1 text-xs"
                          data-testid={`quote-doc-${idx}-${docId}`}
                        >
                          <FileText className="h-3 w-3 text-muted-foreground" />
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="flex-1 truncate hover:underline"
                          >
                            {d?.filename ?? `Document #${docId}`}
                          </a>
                          {d && (
                            <span className="text-muted-foreground">
                              {formatBytes(d.sizeBytes)}
                            </span>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => detachDoc(idx, docId)}
                            data-testid={`button-detach-quote-${idx}-${docId}`}
                          >
                            <Trash2 className="h-3 w-3 text-destructive" />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                );
              })()}
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addRow}
            data-testid="button-add-quote"
          >
            <Plus className="mr-2 h-4 w-4" /> Ajouter une offre
          </Button>
          <Button
            onClick={() =>
              save.mutate({
                id: wf.id,
                data: { quotes: normalizeForSave(quotes) },
              })
            }
            disabled={save.isPending}
            data-testid="button-save-quotes"
          >
            {save.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            <Save className="mr-2 h-4 w-4" />
            Enregistrer
          </Button>
        </div>
      </CardContent>
    </Card>
    </div>
  );
}

function WinningQuoteCard({
  wf,
  showOtherQuotes = true,
}: {
  wf: Workflow;
  // When false, the "Other quotes" comparison section is hidden so
  // the card stays focused on just the chosen supplier (used on the
  // Ordering Main tab where the user only needs to act on the
  // winning quote).
  showOtherQuotes?: boolean;
}) {
  const { data: companies } = useListCompanies();
  const { data: docs } = useListWorkflowDocuments(wf.id);
  const allQuotes = wf.quotes ?? [];
  // When three quotes are NOT required, the single quote is the
  // winning one by definition — fall back to the first row even if
  // nothing was explicitly marked. This mirrors the QuotationPanel UI
  // which hides the winning selector for the single-quote case.
  const winning =
    allQuotes.find((q) => q.winning) ??
    (!wf.threeQuoteRequired && allQuotes.length > 0 ? allQuotes[0] : undefined);
  if (!winning) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Aucune offre retenue. Revenez à l'étape Offre de prix et sélectionnez une offre gagnante.
        </AlertDescription>
      </Alert>
    );
  }
  const supplierName =
    winning.companyName ??
    companies?.find((c) => c.id === winning.companyId)?.name ??
    "—";
  const docIds = winning.documentIds ?? [];
  const winningDocs = (docs ?? []).filter((d) => docIds.includes(d.id));
  // Other quotes (non-winning) — surfaced read-only so the approver
  // can see *why* the chosen one is the best (price comparison,
  // supplier alternatives). Only shown when three quotes were
  // required, since the single-quote case has nothing to compare.
  const otherQuotes =
    showOtherQuotes && wf.threeQuoteRequired
      ? allQuotes.filter((q) => q !== winning)
      : [];
  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Offre retenue</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <div className="text-xs text-muted-foreground">Fournisseur</div>
            <div
              className="font-medium"
              data-testid="text-winning-supplier"
            >
              {supplierName}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Montant</div>
            <div
              className="font-medium"
              data-testid="text-winning-amount"
            >
              {winning.amount != null
                ? `${winning.amount} €`
                : "—"}
            </div>
          </div>
        </div>
        {winning.notes && (
          <div>
            <div className="text-xs text-muted-foreground">Notes</div>
            <div className="whitespace-pre-wrap">{winning.notes}</div>
          </div>
        )}
        <div>
          <div className="mb-1 text-xs text-muted-foreground">
            Documents de l'offre
          </div>
          {winningDocs.length === 0 ? (
            <p className="text-xs italic text-muted-foreground">
              Aucun fichier joint à l'offre retenue.
            </p>
          ) : (
            <ul className="space-y-1">
              {winningDocs.map((d) => {
                const href = `/api/documents/${d.id}/download`;
                const isImage = d.mimeType?.startsWith("image/");
                return (
                  <li
                    key={d.id}
                    className="flex items-center gap-2 rounded border bg-background px-2 py-1"
                    data-testid={`winning-doc-${d.id}`}
                  >
                    {isImage ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        className="block h-8 w-8 shrink-0 overflow-hidden rounded border bg-muted"
                      >
                        <img
                          src={href}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      </a>
                    ) : (
                      <FileText className="h-4 w-4 text-muted-foreground" />
                    )}
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-1 truncate hover:underline"
                    >
                      {d.filename}
                    </a>
                    <span className="text-xs text-muted-foreground">
                      {formatBytes(d.sizeBytes)}
                    </span>
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                    >
                      <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        data-testid={`button-download-winning-${d.id}`}
                      >
                        <Download className="h-3 w-3" />
                      </a>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {otherQuotes.length > 0 && (
          <div className="border-t border-primary/20 pt-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Autres offres ({otherQuotes.length})
            </div>
            <ul className="space-y-2" data-testid="list-other-quotes">
              {otherQuotes.map((q, i) => {
                const otherSupplier =
                  q.companyName ??
                  companies?.find((c) => c.id === q.companyId)?.name ??
                  "—";
                const otherDocIds = q.documentIds ?? [];
                const otherDocs = (docs ?? []).filter((d) =>
                  otherDocIds.includes(d.id),
                );
                return (
                  <li
                    key={i}
                    className="rounded-md border bg-background/60 p-2 text-xs"
                    data-testid={`other-quote-${i}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium" data-testid={`text-other-supplier-${i}`}>
                        {otherSupplier}
                      </span>
                      <span className="text-muted-foreground" data-testid={`text-other-amount-${i}`}>
                        {q.amount != null
                          ? `${q.amount} €`
                          : "—"}
                      </span>
                    </div>
                    {q.notes && (
                      <div className="mt-1 whitespace-pre-wrap text-muted-foreground">
                        {q.notes}
                      </div>
                    )}
                    {otherDocs.length > 0 && (
                      <ul className="mt-1.5 space-y-1">
                        {otherDocs.map((d) => {
                          const href = `/api/documents/${d.id}/download`;
                          return (
                            <li
                              key={d.id}
                              className="flex items-center gap-1.5"
                              data-testid={`other-quote-doc-${i}-${d.id}`}
                            >
                              <FileText className="h-3 w-3 text-muted-foreground" />
                              <a
                                href={href}
                                target="_blank"
                                rel="noreferrer"
                                className="flex-1 truncate hover:underline"
                              >
                                {d.filename}
                              </a>
                              <span className="text-muted-foreground">
                                {formatBytes(d.sizeBytes)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ManagerApprovePanel({
  wf,
  onChange,
}: {
  wf: Workflow;
  onChange: () => void;
}) {
  const [comment, setComment] = useState<string>(wf.managerComment ?? "");
  const save = useSaveWorkflow(wf, onChange);
  const { setBeforeAdvance } = useMissingFields();
  // Persist the comment field on global Next Step. We deliberately
  // do NOT auto-set managerApproved here — approval is an explicit
  // action via the dedicated Approve button in this panel.
  useEffect(() => {
    setBeforeAdvance(async () => {
      await save.mutateAsync({
        id: wf.id,
        data: { managerComment: comment || null },
      });
    });
    return () => setBeforeAdvance(null);
  }, [setBeforeAdvance, save, wf.id, comment]);
  // Approve here is a two-step action: persist managerApproved=true and
  // the comment, then immediately advance the workflow to the next step
  // (same effect as clicking the global "Next Step" button afterwards).
  const advance = useAdvanceWorkflow({
    mutation: {
      onSuccess: () => onChange(),
      // Server-side errors are intentionally swallowed here — the
      // approve button only fires once managerApproved is set, so
      // any remaining failure is rare. We don't want the popup that
      // contradicts the new "highlight only" UX.
      onError: () => {},
    },
  });
  // Reject is a *closing* action — it transitions to the terminal
  // REJECTED step on the server. We use the dedicated /reject hook
  // so the backend can record history, audit, and notifications in
  // one atomic transition.
  const reject = useRejectWorkflow({
    mutation: {
      onSuccess: () => onChange(),
      onError: (err) => {
        const msg =
          (err as { data?: { message?: string } }).data?.message ??
          (err as Error).message;
        alert(`Cannot reject: ${msg}`);
      },
    },
  });
  const busy = save.isPending || advance.isPending || reject.isPending;

  function approveAndAdvance() {
    save.mutate(
      {
        id: wf.id,
        data: {
          managerApproved: true,
          managerComment: comment || null,
        },
      },
      {
        onSuccess: () =>
          advance.mutate({ id: wf.id, data: { branch: null } }),
      },
    );
  }
  return (
    <div className="space-y-3">
      <WinningQuoteCard wf={wf} />
      <Card>
        <CardHeader>
          <CardTitle>Validation responsable de service</CardTitle>
          <p className="text-sm text-muted-foreground">
            Approuvez pour transmettre cette demande à la validation financière, ou refusez pour la clôturer.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>Commentaire</Label>
            <Textarea
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              data-testid="input-manager-comment"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={approveAndAdvance}
              disabled={busy}
              data-testid="button-approve"
            >
              {save.isPending || advance.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="mr-2 h-4 w-4" />
              )}
              Approuver
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (
                  !confirm(
                    "Refuser et clôturer cette commande ? Cette action peut être annulée par un Admin ou un Financier-Tous.",
                  )
                )
                  return;
                reject.mutate({
                  id: wf.id,
                  data: { comment: comment || null },
                });
              }}
              disabled={busy}
              data-testid="button-reject"
            >
              {reject.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Refuser &amp; clôturer
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function FinancialApprovePanel({
  wf,
  onChange,
}: {
  wf: Workflow;
  onChange: () => void;
}) {
  const [branch, setBranch] = useState<
    keyof typeof AdvanceWorkflowInputBranch | ""
  >((wf.branch as keyof typeof AdvanceWorkflowInputBranch | null) ?? "");
  const [comment, setComment] = useState<string>(wf.financialComment ?? "");
  const save = useSaveWorkflow(wf, onChange);
  const { setBeforeAdvance: setBeforeAdvanceFin } = useMissingFields();
  // The global Next Step button is hidden on this step
  // (inlineAdvanceStep) so this handler is rarely invoked, but we
  // still register it for consistency: any cross-step advance
  // triggered while editing will persist the typed comment first.
  // We deliberately do NOT auto-set financialApproved here —
  // approval is an explicit action via the inline "Approve & route"
  // button in this panel.
  useEffect(() => {
    setBeforeAdvanceFin(async () => {
      await save.mutateAsync({
        id: wf.id,
        data: { financialComment: comment || null },
      });
    });
    return () => setBeforeAdvanceFin(null);
  }, [setBeforeAdvanceFin, save, wf.id, comment]);
  const advance = useAdvanceWorkflow({
    mutation: {
      onSuccess: () => onChange(),
      // Highlight-only UX — the missing branch is already surfaced
      // via the field highlight, no popup needed.
      onError: () => {},
    },
  });
  const reject = useRejectWorkflow({
    mutation: {
      onSuccess: () => onChange(),
      onError: (err) => {
        const msg =
          (err as { data?: { message?: string } }).data?.message ??
          (err as Error).message;
        alert(`Cannot reject: ${msg}`);
      },
    },
  });
  const busy = save.isPending || advance.isPending || reject.isPending;
  const { missing, setMissing, clearKey } = useMissingFields();

  function approveAndAdvance() {
    if (!branch) {
      // Surface the missing branch as a highlight on the select
      // instead of silently doing nothing, matching the global
      // Next Step button's behaviour.
      setMissing(new Set(["branch"]));
      return;
    }
    // Two-step: persist comment + financialApproved=true, then advance
    // with the chosen branch. Sequenced so the audit log records the
    // approval before the step transition.
    save.mutate(
      {
        id: wf.id,
        data: { financialApproved: true, financialComment: comment || null },
      },
      {
        onSuccess: () =>
          advance.mutate({ id: wf.id, data: { branch } }),
      },
    );
  }
  function rejectDecision() {
    if (
      !confirm(
        "Refuser et clôturer cette commande ? Cette action peut être annulée par un Admin ou un Financier-Tous.",
      )
    )
      return;
    reject.mutate({
      id: wf.id,
      data: { comment: comment || null },
    });
  }

  return (
    <div className="space-y-3">
      <WinningQuoteCard wf={wf} />
      <Card>
        <CardHeader>
          <CardTitle>Validation financière</CardTitle>
          <p className="text-sm text-muted-foreground">
            Choisissez un circuit — K-Order ou GT Invest — puis approuvez pour faire avancer la commande.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>
              Circuit d'approbation<RequiredMark />
            </Label>
            <Select
              value={branch}
              onValueChange={(v) => {
                setBranch(v as keyof typeof AdvanceWorkflowInputBranch);
                if (v) clearKey("branch");
              }}
            >
              <SelectTrigger
                className={`w-full sm:w-64 ${missingInputCls(missing.has("branch"))}`}
                data-testid="select-fin-branch"
              >
                <SelectValue placeholder="Choisir K-Order ou GT Invest…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AdvanceWorkflowInputBranch.K_ORDER}>
                  K-Order
                </SelectItem>
                <SelectItem value={AdvanceWorkflowInputBranch.GT_INVEST}>
                  GT Invest
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Commentaire</Label>
            <Textarea
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              data-testid="input-fin-comment"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={approveAndAdvance}
              disabled={busy || !branch}
              data-testid="button-fin-approve-advance"
            >
              {(save.isPending || advance.isPending) ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="mr-2 h-4 w-4" />
              )}
              Approuver &amp; orienter
            </Button>
            <Button
              variant="destructive"
              onClick={rejectDecision}
              disabled={busy}
              data-testid="button-fin-reject"
            >
              {reject.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Refuser
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function GtInvestPanel({
  wf,
  onChange,
}: {
  wf: Workflow;
  onChange: () => void;
}) {
  const { data: dates } = useListGtInvestDates();
  const qc = useQueryClient();
  const [decision, setDecision] = useState<
    "OK" | "REFUSED" | "POSTPONED" | "ACCORD_PRINCIPE" | ""
  >("");
  const [dateId, setDateId] = useState<string>(
    wf.gtInvestDateId ? String(wf.gtInvestDateId) : "",
  );
  const [comment, setComment] = useState<string>(wf.gtInvestComment ?? "");
  const submit = useSetGtInvestDecision({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries();
        onChange();
      },
    },
  });
  const opt = GT_DECISION_OPTIONS.find((o) => o.value === decision);
  const needsDate = opt?.needsDate ?? false;
  const canSubmit =
    !!decision && (!needsDate || !!dateId) && !submit.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Décision GT Invest</CardTitle>
        {wf.gtInvestDecision && (
          <p className="text-xs text-muted-foreground">
            Dernière décision enregistrée : {gtDecisionLabel(wf.gtInvestDecision)}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label>Décision</Label>
          <Select
            value={decision}
            onValueChange={(v) =>
              setDecision(
                v as "OK" | "REFUSED" | "POSTPONED" | "ACCORD_PRINCIPE",
              )
            }
          >
            <SelectTrigger data-testid="select-gt-decision">
              <SelectValue placeholder="Sélectionner..." />
            </SelectTrigger>
            <SelectContent>
              {GT_DECISION_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <span className="flex items-center gap-2">
                    <o.Icon className={`h-3.5 w-3.5 ${o.tone}`} />
                    {o.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {needsDate && (
          <div className="space-y-1">
            <Label>Date de réunion</Label>
            <Select value={dateId} onValueChange={setDateId}>
              <SelectTrigger data-testid="select-gt-date">
                <SelectValue placeholder="Sélectionner..." />
              </SelectTrigger>
              <SelectContent>
                {(dates ?? []).map((d) => (
                  <SelectItem key={d.id} value={String(d.id)}>
                    {d.date}
                    {d.label ? ` — ${d.label}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="space-y-1">
          <Label>Commentaire (optionnel)</Label>
          <Textarea
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="input-gt-comment"
          />
        </div>
        {submit.error && (
          <Alert variant="destructive">
            <AlertDescription>
              {extractErrorMessage(submit.error)}
            </AlertDescription>
          </Alert>
        )}
        <Button
          disabled={!canSubmit}
          onClick={() => {
            if (!decision) return;
            submit.mutate({
              id: wf.id,
              data: {
                decision,
                dateId: needsDate ? Number(dateId) : null,
                comment: comment || null,
              },
            });
          }}
          data-testid="button-apply-gt"
        >
          <Save className="mr-2 h-4 w-4" /> Appliquer la décision
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Read-only recap of every field captured in steps that have already
 * been completed. Reused on Ordering / Delivery / Validate Invoice /
 * Payment so the operator on the current step can review the full
 * upstream context — including a one-click merged-PDF download — in
 * place, without bouncing to the History tab.
 *
 * `throughStep` is the *current* step; sections strictly earlier than
 * it are shown.
 */
function PriorStepsRecap({
  wf,
  throughStep,
}: {
  wf: Workflow;
  throughStep: Step;
}) {
  const { data: dates } = useListGtInvestDates();
  const exportHref = `${import.meta.env.BASE_URL}api/workflows/${wf.id}/export-pdf`;

  const ORDER: Step[] = [
    "NEW",
    "QUOTATION",
    "VALIDATING_QUOTE_FINANCIAL",
    "VALIDATING_BY_FINANCIAL",
    "GT_INVEST",
    "ORDERING",
    "DELIVERY",
    "INVOICE",
    "VALIDATING_INVOICE",
    "PAYMENT",
  ];
  const cutoff = ORDER.indexOf(throughStep);
  const show = (step: Step) => {
    const idx = ORDER.indexOf(step);
    return idx >= 0 && idx < cutoff;
  };

  const gtDate = dates?.find((d) => d.id === wf.gtInvestDateId)?.date ?? null;
  const gtResult = gtDecisionLabel(wf.gtInvestDecision);

  const fmtDate = fmtDateUtil;
  const fmtDateTime = fmtDateTimeUtil;
  const fmtMoney = (n: number | null | undefined, c?: string | null) =>
    n != null ? `${n} ${c ?? ""}`.trim() : "—";
  const fmtBool = (b: boolean | null | undefined) =>
    b == null ? "—" : b ? "Yes" : "No";
  const orDash = (v: string | null | undefined) =>
    v && v.length > 0 ? v : "—";

  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="grid grid-cols-[180px_1fr] gap-3 py-1 text-sm">
      <div className="text-muted-foreground">{label}</div>
      <div className="break-words">{value}</div>
    </div>
  );
  const Section = ({
    title,
    children,
  }: {
    title: string;
    children: React.ReactNode;
  }) => (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="divide-y">{children}</div>
    </div>
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Récapitulatif</CardTitle>
        <Button asChild variant="outline" size="sm">
          <a
            href={exportHref}
            target="_blank"
            rel="noreferrer"
            data-testid="button-export-merged-pdf-recap"
          >
            <Download className="mr-2 h-4 w-4" />
            Exporter PDF groupé
          </a>
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <Section title="Général">
          <Row label="Référence" value={<span className="font-mono">{wf.reference}</span>} />
          <Row label="Titre" value={wf.title} />
          <Row label="Service" value={wf.departmentName} />
          <Row label="Demandé par" value={wf.createdByName} />
          <Row label="Priorité" value={wf.priority} />
          <Row label="Circuit" value={orDash(wf.branch)} />
          <Row label="Description" value={orDash(wf.description)} />
          <Row label="Date souhaitée" value={fmtDate(wf.neededBy)} />
          <Row label="Créé le" value={fmtDateTime(wf.createdAt)} />
        </Section>

        {show("QUOTATION") && (
          <Section title="2 · Offre de prix">
            <Row label="3 offres requises" value={fmtBool(wf.threeQuoteRequired)} />
            {wf.quotes && wf.quotes.length > 0 ? (
              <div className="overflow-x-auto py-1">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="px-2 py-1">Fournisseur</th>
                      <th className="px-2 py-1">Montant</th>
                      <th className="px-2 py-1">Notes</th>
                      <th className="px-2 py-1">Retenu</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wf.quotes.map((q, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-1">{orDash(q.companyName)}</td>
                        <td className="px-2 py-1">{fmtMoney(q.amount)}</td>
                        <td className="px-2 py-1">{orDash(q.notes)}</td>
                        <td className="px-2 py-1">{q.winning ? "★" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Row label="Offres" value="—" />
            )}
          </Section>
        )}

        {show("VALIDATING_QUOTE_FINANCIAL") && (
          <Section title="3 · Validation responsable">
            <Row label="Approuvé" value={fmtBool(wf.managerApproved)} />
            <Row label="Commentaire" value={orDash(wf.managerComment)} />
          </Section>
        )}

        {show("VALIDATING_BY_FINANCIAL") && (
          <Section title="4 · Validation financière">
            <Row label="Approuvé" value={fmtBool(wf.financialApproved)} />
            <Row label="Commentaire" value={orDash(wf.financialComment)} />
          </Section>
        )}

        {show("GT_INVEST") &&
        (wf.branch === "GT_INVEST" || wf.gtInvestDateId || wf.gtInvestResultId) ? (
          <Section title="GT Invest">
            <Row label="Date de réunion" value={fmtDate(gtDate)} />
            <Row label="Résultat" value={orDash(gtResult)} />
            <Row label="Commentaire" value={orDash(wf.gtInvestComment)} />
          </Section>
        ) : null}

        {show("ORDERING") && (
          <Section title="5 · Commande">
            <Row label="N° de commande" value={orDash(wf.orderNumber)} />
            <Row label="Date de commande" value={fmtDate(wf.orderDate)} />
          </Section>
        )}

        {show("DELIVERY") && (
          <Section title="6 · Livraison">
            <Row label="Livré le" value={fmtDate(wf.deliveredOn)} />
            <Row label="Notes" value={orDash(wf.deliveryNotes)} />
          </Section>
        )}

        {show("INVOICE") && (
          <Section title="7 · Facture">
            <Row label="N° de facture" value={orDash(wf.invoiceNumber)} />
            <Row label="Montant facture" value={fmtMoney(wf.invoiceAmount)} />
            <Row label="Date de facture" value={fmtDate(wf.invoiceDate)} />
          </Section>
        )}

        {show("VALIDATING_INVOICE") && (
          <Section title="8 · Validation facture">
            <Row label="Validé" value={fmtBool(wf.invoiceValidated)} />
            <Row label="Signé par" value={orDash(wf.invoiceSignedBy)} />
            <Row label="Signé le" value={fmtDateTime(wf.invoiceSignedAt)} />
          </Section>
        )}
      </CardContent>
    </Card>
  );
}

function OrderingPanel({
  wf,
  onChange,
}: {
  wf: Workflow;
  onChange: () => void;
}) {
  // Date inputs need a bare YYYY-MM-DD; the API may return either
  // that shape (Postgres `date` columns) or a full ISO timestamp,
  // depending on how the value was written. Normalise both.
  const toDateInput = (s: string | null | undefined): string =>
    s ? String(s).slice(0, 10) : "";
  const [orderNumber, setOrderNumber] = useState(wf.orderNumber ?? "");
  const [orderDate, setOrderDate] = useState(toDateInput(wf.orderDate));
  const save = useSaveWorkflow(wf, onChange);
  const { missing, clearKey, setBeforeAdvance } = useMissingFields();
  // Auto-save the form when the user clicks the global Next Step
  // so freshly-typed values are taken into account by the server's
  // advance prerequisites — no need to click Save first.
  useEffect(() => {
    setBeforeAdvance(async () => {
      await save.mutateAsync({
        id: wf.id,
        data: { orderNumber, orderDate: orderDate || null },
      });
    });
    return () => setBeforeAdvance(null);
  }, [setBeforeAdvance, save, wf.id, orderNumber, orderDate]);
  // Keep local form state in sync with the latest server snapshot so
  // a Save → refetch (or another tab editing) is reflected here.
  useEffect(() => {
    setOrderNumber(wf.orderNumber ?? "");
    setOrderDate(toDateInput(wf.orderDate));
  }, [wf.orderNumber, wf.orderDate]);
  // Defensive: clear the "missing" badge as soon as the order number
  // has a value locally — covers the case where the user filled the
  // input after a failed Advance attempt.
  useEffect(() => {
    if (orderNumber) clearKey("orderNumber");
  }, [orderNumber, clearKey]);
  return (
    <div className="space-y-4">
      {/* Recap of prior steps lives on the dedicated Summary tab now;
          on the Main tab we only show what is needed to act on the
          Ordering step itself — the chosen supplier and the order
          form. */}
      <WinningQuoteCard wf={wf} showOtherQuotes={false} />
    <Card>
      <CardHeader>
        <CardTitle>Détails de la commande</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>
              N° de commande<RequiredMark />
            </Label>
            <Input
              value={orderNumber}
              onChange={(e) => {
                setOrderNumber(e.target.value);
                if (e.target.value) clearKey("orderNumber");
              }}
              className={missingInputCls(missing.has("orderNumber"))}
              data-testid="input-order-number"
            />
          </div>
          <div className="space-y-1">
            <Label>Date de commande</Label>
            <Input
              type="date"
              value={orderDate}
              onChange={(e) => setOrderDate(e.target.value)}
              data-testid="input-order-date"
            />
          </div>
        </div>
        <Button
          onClick={() =>
            save.mutate({
              id: wf.id,
              data: { orderNumber, orderDate: orderDate || null },
            })
          }
          disabled={save.isPending}
          data-testid="button-save-order"
        >
          <Save className="mr-2 h-4 w-4" /> Enregistrer
        </Button>
        <StepDocumentUploader
          wf={wf}
          kind="ORDER"
          step="ORDERING"
          label="Document de commande"
          required
        />
      </CardContent>
    </Card>
    </div>
  );
}

function DeliveryPanel({
  wf,
  onChange,
}: {
  wf: Workflow;
  onChange: () => void;
}) {
  const [deliveredOn, setDeliveredOn] = useState(wf.deliveredOn ?? "");
  const [deliveryNotes, setDeliveryNotes] = useState(wf.deliveryNotes ?? "");
  const save = useSaveWorkflow(wf, onChange);
  const { setBeforeAdvance } = useMissingFields();
  useEffect(() => {
    setBeforeAdvance(async () => {
      await save.mutateAsync({
        id: wf.id,
        data: { deliveredOn: deliveredOn || null, deliveryNotes },
      });
    });
    return () => setBeforeAdvance(null);
  }, [setBeforeAdvance, save, wf.id, deliveredOn, deliveryNotes]);
  return (
    <div className="space-y-4">
    <Card>
      <CardHeader>
        <CardTitle>Livraison</CardTitle>
        <p className="text-sm text-muted-foreground">
          Enregistrez la date de livraison si connue. La date et le bon de livraison sont facultatifs.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label>Livré le</Label>
          <Input
            type="date"
            value={deliveredOn}
            onChange={(e) => setDeliveredOn(e.target.value)}
            data-testid="input-delivered-on"
          />
        </div>
        <div className="space-y-1">
          <Label>Notes</Label>
          <Textarea
            rows={3}
            value={deliveryNotes}
            onChange={(e) => setDeliveryNotes(e.target.value)}
            data-testid="input-delivery-notes"
          />
        </div>
        <Button
          onClick={() =>
            save.mutate({
              id: wf.id,
              data: {
                deliveredOn: deliveredOn || null,
                deliveryNotes,
              },
            })
          }
          disabled={save.isPending}
          data-testid="button-save-delivery"
        >
          <Save className="mr-2 h-4 w-4" /> Enregistrer
        </Button>
        <StepDocumentUploader
          wf={wf}
          kind="DELIVERY"
          step="DELIVERY"
          label="Bon de livraison (optionnel)"
        />
      </CardContent>
    </Card>
    </div>
  );
}

function InvoicePanel({
  wf,
  onChange,
}: {
  wf: Workflow;
  onChange: () => void;
}) {
  const [invoiceNumber, setInvoiceNumber] = useState(wf.invoiceNumber ?? "");
  const [invoiceAmount, setInvoiceAmount] = useState(
    wf.invoiceAmount != null ? String(wf.invoiceAmount) : "",
  );
  const [invoiceDate, setInvoiceDate] = useState(wf.invoiceDate ?? "");
  const save = useSaveWorkflow(wf, onChange);
  const { missing, clearKey, setBeforeAdvance } = useMissingFields();
  useEffect(() => {
    setBeforeAdvance(async () => {
      await save.mutateAsync({
        id: wf.id,
        data: {
          invoiceNumber,
          invoiceAmount: invoiceAmount ? Number(invoiceAmount) : null,
          invoiceDate: invoiceDate || null,
        },
      });
    });
    return () => setBeforeAdvance(null);
  }, [
    setBeforeAdvance,
    save,
    wf.id,
    invoiceNumber,
    invoiceAmount,
    invoiceDate,
  ]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Détails de la facture</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label>
              N° de facture<RequiredMark />
            </Label>
            <Input
              value={invoiceNumber}
              onChange={(e) => {
                setInvoiceNumber(e.target.value);
                if (e.target.value) clearKey("invoiceNumber");
              }}
              className={missingInputCls(missing.has("invoiceNumber"))}
              data-testid="input-invoice-number"
            />
          </div>
          <div className="space-y-1">
            <Label>
              Montant (€)<RequiredMark />
            </Label>
            <Input
              type="number"
              step="0.01"
              value={invoiceAmount}
              onChange={(e) => {
                setInvoiceAmount(e.target.value);
                if (e.target.value) clearKey("invoiceAmount");
              }}
              className={missingInputCls(missing.has("invoiceAmount"))}
              data-testid="input-invoice-amount"
            />
          </div>
          <div className="space-y-1">
            <Label>Date de facture</Label>
            <Input
              type="date"
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
              data-testid="input-invoice-date"
            />
          </div>
        </div>
        <Button
          onClick={() =>
            save.mutate({
              id: wf.id,
              data: {
                invoiceNumber,
                invoiceAmount: invoiceAmount ? Number(invoiceAmount) : null,
                invoiceDate: invoiceDate || null,
              },
            })
          }
          disabled={save.isPending}
          data-testid="button-save-invoice"
        >
          <Save className="mr-2 h-4 w-4" /> Enregistrer
        </Button>
        <StepDocumentUploader
          wf={wf}
          kind="INVOICE"
          step="INVOICE"
          label="Document de facture"
          required
        />
      </CardContent>
    </Card>
  );
}

function InvoiceValidationPanel({
  wf,
  user,
  onChange,
}: {
  wf: Workflow;
  user: SessionUser;
  onChange: () => void;
}) {
  // Default the signer to the connected user's full name so finance
  // doesn't have to retype it on every workflow. They can still
  // override it if a different person physically signs the paper
  // copy.
  const [signedBy, setSignedBy] = useState(
    wf.invoiceSignedBy ?? user.displayName ?? "",
  );
  const save = useSaveWorkflow(wf, onChange);
  const { data: settings } = useGetSettings();
  const [signing, setSigning] = useState(false);
  // Build a merged PDF of every attached document (quote → order →
  // delivery → invoice). The endpoint returns application/pdf which
  // we hand off to the browser as a regular download.
  const exportHref = `${import.meta.env.BASE_URL}api/workflows/${wf.id}/export-pdf`;

  // When the admin enables the Windows signing agent, the browser
  // (running on the operator's own PC) is responsible for sending
  // the merged invoice pack to the local agent at
  // http://localhost:<port>/sign before the workflow is allowed to
  // advance. The server never reaches out to the agent — it could
  // not, since the agent only listens on each user's loopback
  // interface and the port is defined at agent install time.
  async function signWithLocalAgent(): Promise<true | string> {
    const port = settings?.signingAgentPort;
    if (!port) return "Signing agent port is not configured in Settings.";
    try {
      const pdf = await fetch(exportHref, { credentials: "include" });
      if (!pdf.ok) return `Could not fetch the merged PDF (${pdf.status}).`;
      const blob = await pdf.blob();
      const r = await fetch(`http://localhost:${port}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: blob,
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        return `Signing agent rejected the request (${r.status}). ${txt}`.trim();
      }
      return true;
    } catch (e) {
      return `Could not reach the signing agent on localhost:${port}. Make sure the Windows agent service is running. (${(e as Error).message})`;
    }
  }

  const advance = useAdvanceWorkflow({
    mutation: {
      onSuccess: () => onChange(),
      onError: () => {},
    },
  });

  async function onValidate() {
    if (settings?.certSigningEnabled) {
      setSigning(true);
      const result = await signWithLocalAgent();
      setSigning(false);
      if (result !== true) {
        alert(result);
        return;
      }
    }
    save.mutate(
      {
        id: wf.id,
        data: {
          invoiceValidated: true,
          invoiceSignedBy: signedBy || null,
        },
      },
      {
        onSuccess: () =>
          advance.mutate({ id: wf.id, data: { branch: null } }),
      },
    );
  }
  const reject = useRejectWorkflow({
    mutation: {
      onSuccess: () => onChange(),
      onError: (err) => {
        const msg =
          (err as { data?: { message?: string } }).data?.message ??
          (err as Error).message;
        alert(`Impossible de refuser : ${msg}`);
      },
    },
  });
  const busy = save.isPending || advance.isPending || reject.isPending || signing;
  return (
    <div className="space-y-4">
    <Card>
      <CardHeader>
        <CardTitle>Validation de la facture</CardTitle>
        <p className="text-sm text-muted-foreground">
          Validez pour passer au Paiement, ou refusez pour clôturer la commande. Utilisez <em>Exporter PDF groupé</em> pour télécharger le dossier complet.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label>Signé par (optionnel)</Label>
          <Input
            value={signedBy}
            onChange={(e) => setSignedBy(e.target.value)}
            placeholder="Nom du signataire"
            data-testid="input-invoice-signedby"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" data-testid="button-export-merged-pdf">
            <a href={exportHref} target="_blank" rel="noreferrer">
              <Download className="mr-2 h-4 w-4" />
              Exporter PDF groupé
            </a>
          </Button>
          <Button
            onClick={onValidate}
            disabled={busy}
            data-testid="button-invoice-validate"
          >
            {save.isPending || advance.isPending || signing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {signing
              ? "Signature en cours…"
              : settings?.certSigningEnabled
                ? "Signer & valider"
                : "Valider"}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (
                !confirm(
                  "Refuser cette facture et clôturer la commande ? Cette action peut être annulée par un Admin ou un Financier-Tous.",
                )
              )
                return;
              reject.mutate({ id: wf.id, data: { comment: null } });
            }}
            disabled={busy}
            data-testid="button-invoice-reject"
          >
            {reject.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Refuser &amp; clôturer
          </Button>
        </div>
      </CardContent>
    </Card>
    </div>
  );
}

function PaymentPanel({
  wf,
  onChange,
}: {
  wf: Workflow;
  onChange: () => void;
}) {
  // Payment is the last actionable step — advancing from PAYMENT
  // transitions the workflow to the terminal DONE state, so the
  // "Paid" button below uses the same advance call as Next Step but
  // with a clearer label for finance users.
  const advance = useAdvanceWorkflow({
    mutation: {
      onSuccess: () => onChange(),
      onError: (err) => {
        const msg =
          (err as { data?: { message?: string } }).data?.message ??
          (err as Error).message;
        alert(`Cannot mark as paid: ${msg}`);
      },
    },
  });
  return (
    <div className="space-y-4">
      <PriorStepsRecap wf={wf} throughStep="PAYMENT" />
    <Card>
      <CardHeader>
        <CardTitle>Paiement</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Consultez le récapitulatif ci-dessus, puis cliquez sur <em>Payer</em> une fois le virement de{" "}
          <strong>
            {wf.invoiceAmount} €
          </strong>{" "}
          pour <span className="font-mono">{wf.reference}</span> effectué.
        </p>
        <div>
          <Button
            onClick={() => {
              if (!confirm("Marquer cette commande comme payée et la clôturer ?"))
                return;
              advance.mutate({ id: wf.id, data: { branch: null } });
            }}
            disabled={advance.isPending}
            data-testid="button-paid"
          >
            {advance.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-2 h-4 w-4" />
            )}
            Payer
          </Button>
        </div>
      </CardContent>
    </Card>
    </div>
  );
}

function DocumentsPanel({ wf }: { wf: Workflow }) {
  const { data: docs } = useListWorkflowDocuments(wf.id);
  const upload = useUploadWorkflowDocument();
  const del = useDeleteDocument();
  const qc = useQueryClient();
  const [kind, setKind] = useState<keyof typeof UploadDocumentInputKind>(
    "OTHER",
  );

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const base64 = await fileToBase64(f);
    upload.mutate(
      {
        id: wf.id,
        data: {
          step: wf.currentStep,
          filename: f.name,
          mimeType: f.type || "application/octet-stream",
          kind,
          contentBase64: base64,
          replacesDocumentId: null,
        },
      },
      {
        onSettled: () => {
          e.target.value = "";
          qc.invalidateQueries();
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Documents</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/30 p-3">
          <div className="space-y-1">
            <Label className="text-xs">Type</Label>
            <Select
              value={kind}
              onValueChange={(v) =>
                setKind(v as keyof typeof UploadDocumentInputKind)
              }
            >
              <SelectTrigger
                className="w-44"
                data-testid="select-doc-kind"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(UploadDocumentInputKind).map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Téléverser un fichier</Label>
            <Input
              type="file"
              onChange={onPick}
              data-testid="input-file-upload"
            />
          </div>
          {upload.isPending && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Chargement…
            </span>
          )}
        </div>

        <Separator />

        {(docs ?? []).length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Aucun document ajouté.
          </p>
        ) : (
          <div className="divide-y">
            {(docs ?? []).map((d) => {
              const isImage = d.mimeType?.startsWith("image/");
              const thumbUrl = `/api/documents/${d.id}/download`;
              return (
              <div
                key={d.id}
                className="flex items-center gap-3 py-2"
                data-testid={`doc-row-${d.id}`}
              >
                {isImage ? (
                  // Hover-to-preview: small thumbnail expands to a 320px
                  // floating preview on hover. Pure CSS with `group` so we
                  // don't need extra state and the preview pinned to the
                  // thumbnail naturally follows scroll.
                  <a
                    href={thumbUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="group relative block h-10 w-10 shrink-0 overflow-hidden rounded border bg-muted"
                    data-testid={`doc-thumb-${d.id}`}
                  >
                    <img
                      src={thumbUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                    <span className="pointer-events-none invisible absolute left-12 top-0 z-30 w-80 rounded border bg-background p-1 opacity-0 shadow-xl transition group-hover:visible group-hover:opacity-100">
                      <img
                        src={thumbUrl}
                        alt=""
                        className="block w-full rounded object-contain"
                      />
                    </span>
                  </a>
                ) : (
                  <FileText className="h-5 w-5 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">
                    {d.filename}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {d.kind} · v{d.version} · {STEP_LABEL[d.step as Step]} ·{" "}
                    {formatBytes(d.sizeBytes)} · {d.uploadedByName}
                  </div>
                </div>
                <Button asChild variant="ghost" size="icon">
                  <a
                    href={thumbUrl}
                    target="_blank"
                    rel="noreferrer"
                    data-testid={`button-download-${d.id}`}
                  >
                    <Download className="h-4 w-4" />
                  </a>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    del.mutate(
                      { id: d.id },
                      {
                        onSuccess: () =>
                          qc.invalidateQueries(),
                      },
                    )
                  }
                  data-testid={`button-delete-${d.id}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NotesPanel({ wf }: { wf: Workflow }) {
  const { data: notes } = useListWorkflowNotes(wf.id);
  const qc = useQueryClient();
  const create = useCreateWorkflowNote({
    mutation: { onSuccess: () => qc.invalidateQueries() },
  });
  const [body, setBody] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Textarea
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Ajouter une note pour cette étape…"
            data-testid="input-note-body"
          />
          <div className="flex justify-end">
            <Button
              onClick={() => {
                if (!body.trim()) return;
                create.mutate(
                  { id: wf.id, data: { step: wf.currentStep, body } },
                  { onSuccess: () => setBody("") },
                );
              }}
              disabled={create.isPending || !body.trim()}
              data-testid="button-add-note"
            >
              <Plus className="mr-2 h-4 w-4" /> Ajouter une note
            </Button>
          </div>
        </div>
        <Separator />
        {(notes ?? []).length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Aucune note.
          </p>
        ) : (
          <div className="space-y-3">
            {(notes ?? []).map((n) => (
              <div
                key={n.id}
                className="rounded-md border bg-muted/20 p-3"
                data-testid={`note-${n.id}`}
              >
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {n.authorName}
                  </span>
                  <span>
                    {STEP_LABEL[n.step as Step]} ·{" "}
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="mt-1 whitespace-pre-wrap text-sm">{n.body}</div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HistoryPanel({ wf }: { wf: Workflow }) {
  const { data: hist } = useListWorkflowHistory(wf.id);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Historique</CardTitle>
      </CardHeader>
      <CardContent>
        {(hist ?? []).length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Aucun événement.
          </p>
        ) : (
          <ol className="space-y-3">
            {(hist ?? []).map((h, idx) => (
              <li
                key={h.id}
                className="flex items-start gap-3"
                data-testid={`history-${h.id}`}
              >
                <div className="flex flex-col items-center">
                  <div className="h-2 w-2 rounded-full bg-primary" />
                  {idx < (hist ?? []).length - 1 && (
                    <div className="my-1 h-full w-px bg-border" />
                  )}
                </div>
                <div className="flex-1 pb-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">
                      {h.action === "ADVANCE"
                        ? "Étape suivante"
                        : h.action === "REJECT"
                          ? "Clôturer"
                          : h.action === "UNDO"
                            ? "Annuler"
                            : h.action === "CREATE"
                              ? "Créer"
                              : h.action === "EDIT"
                                ? "Modifier"
                                : h.action}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(h.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {h.actorName}
                    {h.fromStep && h.toStep
                      ? `: ${STEP_LABEL[h.fromStep as Step] ?? h.fromStep} → ${STEP_LABEL[h.toStep as Step] ?? h.toStep}`
                      : ""}
                  </div>
                  {h.details && (
                    <div className="mt-1 text-xs italic text-muted-foreground">
                      {h.details}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// InvestmentFormPanel — read-only view of the GT Invest questionnaire
// ─────────────────────────────────────────────────────────────────────────────

const REQUEST_NATURE_LABEL: Record<string, string> = {
  NEW: "Nouvel achat",
  REPLACEMENT: "Remplacement",
};

const EXCEPTION_PROCEDURE_LABEL: Record<string, string> = {
  NONE: "Non",
  LIVRE_I: "Oui – Livre I (marchés au-dessous des seuils européens)",
  LIVRE_II: "Oui – Livre II (marchés au-dessus des seuils européens)",
};

const BUDGET_POSITION_LABEL: Record<string, string> = {
  YES: "Oui",
  NO: "Non",
  TO_CONFIRM: "À confirmer",
};

const IMPACT_LABEL: Record<string, string> = {
  CRITICAL: "Critique (interruption des soins)",
  MODERATE: "Modéré (perturbation des opérations)",
  MINOR: "Mineur",
};

function IFRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode | null | undefined;
}) {
  if (value === null || value === undefined || value === "" || value === false) return null;
  return (
    <div className="grid grid-cols-[40%_1fr] gap-2 py-1.5 text-sm border-b last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function IFBool({ v }: { v: boolean | null | undefined }) {
  if (v === null || v === undefined) return null;
  return <span>{v ? "Oui" : "Non"}</span>;
}

function IFSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 mt-4">
        {title}
      </h3>
      {children}
    </div>
  );
}

function InvestmentFormPanel({ wf }: { wf: Workflow }) {
  const f = wf.investmentForm as InvestmentForm | null | undefined;
  const { data: ifSettings } = useGetSettings();
  const ifLimitX = ifSettings?.limitX ?? null;
  const ifLimitY =
    (ifSettings as { quoteThresholdLivreI?: number | null } | undefined)
      ?.quoteThresholdLivreI ?? null;
  const ifAmount = f?.estimatedAmount5y ?? null;
  const ifTier: "STANDARD" | "BAND_XY" | "ABOVE_Y" =
    ifAmount == null
      ? "STANDARD"
      : ifLimitY != null && ifAmount > ifLimitY
        ? "ABOVE_Y"
        : ifLimitX != null && ifAmount > ifLimitX
          ? "BAND_XY"
          : "STANDARD";

  if (!f) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground text-sm">
          <ClipboardList className="mx-auto mb-3 h-10 w-10 opacity-30" />
          <p>Aucun formulaire d'investissement rempli pour ce workflow.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5" />
          Formulaire de demande d'investissement
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-y-0 space-y-0">

        <IFSection title="1 · Identification générale">
          <IFRow label="Responsable / Leader du projet" value={f.projectLeader} />
          <IFRow
            label="Type(s) d'investissement"
            value={
              f.investmentTypes?.length
                ? f.investmentTypes.join(", ")
                : null
            }
          />
        </IFSection>

        <IFSection title="2 · Description du besoin">
          <IFRow label="Justification" value={f.justification} />
          <IFRow label="Testé en demo au CHdN ?" value={<IFBool v={f.demoTested} />} />
          <IFRow label="Contexte du test" value={f.demoContext} />
        </IFSection>

        <IFSection title="3 · Nature de la demande">
          <IFRow
            label="Nature"
            value={f.requestNature ? (REQUEST_NATURE_LABEL[f.requestNature] ?? f.requestNature) : null}
          />
          <IFRow label="Équipement remplacé (réf.)" value={f.replacedEquipmentRef} />
          <IFRow label="Localisation équipement existant" value={f.replacedEquipmentLocation} />
          <IFRow label="Motif du remplacement" value={f.replacementReason} />
          <IFRow label="Mis hors service ?" value={<IFBool v={f.decommissioned} />} />
          <IFRow label="Devenir de l'ancien équipement" value={f.decommissionedNote} />
        </IFSection>

        <IFSection title="4 · Aspects financiers">
          <IFRow
            label="4.1 Coût estimé 5 ans (HTVA)"
            value={
              f.estimatedAmount5y != null
                ? `${f.estimatedAmount5y.toLocaleString("fr-BE")} €`
                : null
            }
          />
          {/* Q4.1.1 — only when amount is in the X–Y band */}
          {ifTier === "BAND_XY" && (
            <IFRow
              label="4.1.1 Procédure d'exception Livre I ?"
              value={f.exceptionProcedure === "LIVRE_I" ? "Oui" : "Non"}
            />
          )}
          {/* Q4.1.2 — justification when Livre I exception was granted */}
          {ifTier === "BAND_XY" && f.exceptionProcedure === "LIVRE_I" && (
            <IFRow
              label="4.1.2 Justification procédure d'exception Livre I"
              value={f.exceptionJustification}
            />
          )}
          {/* Q4.1.3 — only when amount is above Y */}
          {ifTier === "ABOVE_Y" && (
            <IFRow
              label="4.1.3 Procédure d'exception Livre II ?"
              value={f.exceptionProcedure === "LIVRE_II" ? "Oui" : "Non"}
            />
          )}
          {/* Q4.1.4 — justification when Livre II exception was granted */}
          {ifTier === "ABOVE_Y" && f.exceptionProcedure === "LIVRE_II" && (
            <IFRow
              label="4.1.4 Justification procédure d'exception Livre II"
              value={f.exceptionJustification}
            />
          )}
          <IFRow
            label="4.2 Position budgétaire connue ?"
            value={
              f.budgetPositionKnown
                ? (BUDGET_POSITION_LABEL[f.budgetPositionKnown] ?? f.budgetPositionKnown)
                : null
            }
          />
          <IFRow label="4.2.1 Position budgétaire" value={f.budgetPosition} />
        </IFSection>

        <IFSection title="5 · Fournisseur">
          <IFRow label="Nom du fournisseur" value={f.supplierName} />
          <IFRow label="Contact" value={f.supplierContact} />
        </IFSection>

        <IFSection title="6 · Aspects techniques">
          <IFRow label="Aménagements architecturaux ?" value={<IFBool v={f.architecturalWorks} />} />
          <IFRow label="Connexion informatique ?" value={<IFBool v={f.itConnection} />} />
          <IFRow label="Interopérabilité systèmes critiques ?" value={<IFBool v={f.systemInterop} />} />
          <IFRow
            label="Types d'accès"
            value={f.accessTypes?.length ? f.accessTypes.join(", ") : null}
          />
        </IFSection>

        <IFSection title="7 · Données, sécurité et conformité">
          <IFRow
            label="Types de données traitées"
            value={f.dataTypes?.length ? f.dataTypes.join(", ") : null}
          />
          <IFRow
            label="Impact indisponibilité"
            value={
              f.availabilityImpact
                ? (IMPACT_LABEL[f.availabilityImpact] ?? f.availabilityImpact)
                : null
            }
          />
          <IFRow label="Intelligence artificielle ?" value={<IFBool v={f.hasAI} />} />
        </IFSection>

        <IFSection title="8 · Consommables et sécurité">
          <IFRow label="Consommables nécessaires ?" value={<IFBool v={f.consumablesNeeded} />} />
          <IFRow label="Offre consommables jointe ?" value={<IFBool v={f.consumablesOfferAttached} />} />
          <IFRow label="Gaz ou produits chimiques ?" value={<IFBool v={f.hazardousConsumables} />} />
        </IFSection>

        <IFSection title="9 · Maintenance, hygiène et exploitation">
          <IFRow label="Durée de la garantie" value={f.warrantyDuration} />
          <IFRow label="Contrat de maintenance ?" value={<IFBool v={f.maintenanceContract} />} />
          <IFRow label="Nettoyage / désinfection requis ?" value={<IFBool v={f.cleaningRequired} />} />
          <IFRow label="Stérilisation requise ?" value={<IFBool v={f.sterilizationRequired} />} />
        </IFSection>

        <IFSection title="10 · Formation et mise en service">
          <IFRow label="Formation nécessaire ?" value={<IFBool v={f.trainingRequired} />} />
          <IFRow label="Offre de formation jointe ?" value={<IFBool v={f.trainingOfferAttached} />} />
          <IFRow label="Date souhaitée de mise en service" value={f.commissioningDate} />
        </IFSection>

        {f.documentsProvided?.length ? (
          <IFSection title="11 · Documentation fournie">
            <div className="space-y-1">
              {f.documentsProvided.map((d) => (
                <div key={d} className="flex items-center gap-2 text-sm py-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500 flex-shrink-0" />
                  {d}
                </div>
              ))}
            </div>
          </IFSection>
        ) : null}

      </CardContent>
    </Card>
  );
}
