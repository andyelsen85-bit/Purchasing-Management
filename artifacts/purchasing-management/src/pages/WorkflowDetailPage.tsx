import { useState } from "react";
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
  useListGtInvestResults,
  useUpdateWorkflow,
  useAdvanceWorkflow,
  useRejectWorkflow,
  useUndoWorkflow,
  useUploadWorkflowDocument,
  useDeleteDocument,
  useCreateWorkflowNote,
  useGetSettings,
  AdvanceWorkflowInputBranch,
  UploadDocumentInputKind,
  type Workflow,
  type QuoteEntry,
} from "@/lib/api";
import { StepProgress } from "@/components/StepProgress";
import { STEP_LABEL, type Step, fileToBase64, formatBytes } from "@/lib/steps";
import type { SessionUser } from "@/components/AuthGate";

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
          <AlertDescription>Workflow not found.</AlertDescription>
        </Alert>
      </div>
    );
  }

  function refresh() {
    qc.invalidateQueries();
  }

  return (
    <div className="space-y-6 p-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setLocation("/workflows")}
        data-testid="button-back"
      >
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to workflows
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
            Current step
          </TabsTrigger>
          <TabsTrigger value="docs" data-testid="tab-documents">
            <FileText className="mr-1 h-3.5 w-3.5" /> Documents
          </TabsTrigger>
          <TabsTrigger value="notes" data-testid="tab-notes">
            <MessageSquare className="mr-1 h-3.5 w-3.5" /> Notes
          </TabsTrigger>
          <TabsTrigger value="history" data-testid="tab-history">
            <History className="mr-1 h-3.5 w-3.5" /> History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="step">
          <StepPanel wf={wf} onChange={refresh} />
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
  const advance = useAdvanceWorkflow({
    mutation: {
      onSuccess: () => onChange(),
      onError: (err) => {
        const msg =
          (err as { data?: { message?: string } }).data?.message ??
          (err as Error).message;
        alert(`Cannot advance: ${msg}`);
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
          onClick={() =>
            advance.mutate({
              id: wf.id,
              data: { branch: branch ? branch : null },
            })
          }
          disabled={advance.isPending || isTerminal}
          data-testid="button-advance"
        >
          {advance.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <ArrowRight className="mr-2 h-4 w-4" />
          )}
          Next Step
        </Button>
      )}
      {!isTerminal && (
        <Button
          variant="outline"
          className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => {
            const reason = window.prompt(
              "Close this workflow? Optionally enter a reason — it will be saved with the close event.",
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
          Close workflow
        </Button>
      )}
      {canUndo && (
        <Button
          variant="outline"
          onClick={() => undo.mutate({ id: wf.id })}
          disabled={undo.isPending || wf.currentStep === "NEW"}
          data-testid="button-undo"
        >
          <Undo2 className="mr-2 h-4 w-4" /> Undo
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
}: {
  wf: Workflow;
  kind: keyof typeof UploadDocumentInputKind;
  step: Step;
  label: string;
}) {
  const { data: docs } = useListWorkflowDocuments(wf.id);
  const upload = useUploadWorkflowDocument();
  const del = useDeleteDocument();
  const qc = useQueryClient();
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
    } finally {
      e.target.value = "";
      qc.invalidateQueries();
    }
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">{label}</Label>
        {upload.isPending && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Uploading…
          </span>
        )}
      </div>
      {matching.length === 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`text-no-doc-${kind}`}
        >
          No file attached yet.
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

function StepPanel({ wf, onChange }: { wf: Workflow; onChange: () => void }) {
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
      return <InvoiceValidationPanel wf={wf} onChange={onChange} />;
    case "PAYMENT":
      return <PaymentPanel wf={wf} onChange={onChange} />;
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
          Workflow rejected and closed
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div>
          Closed at step{" "}
          <strong>
            {fromStep ? STEP_LABEL[fromStep] : "an approval step"}
          </strong>
          .
        </div>
        {reason ? (
          <div className="rounded-md bg-muted/50 p-3 text-muted-foreground">
            <div className="text-[11px] uppercase tracking-wider">Reason</div>
            <div className="mt-1 whitespace-pre-wrap">{reason}</div>
          </div>
        ) : (
          <div className="text-muted-foreground">
            No reason was recorded. Admin or Financial-All can Undo to reopen.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function useSaveWorkflow(wf: Workflow, onChange: () => void) {
  return useUpdateWorkflow({
    mutation: { onSuccess: () => onChange() },
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

  // Dynamic "3 quotes required" check: derive from the first quote's
  // amount and the configured limit, so the warning appears as soon
  // as the user types it (before saving). Falls back to the persisted
  // server flag if settings aren't loaded yet.
  const limitX = settings?.limitX ?? null;
  const firstAmount = quotes.find((q) => q.amount != null)?.amount ?? null;
  const threeQuotesRequired =
    limitX != null && firstAmount != null
      ? firstAmount > limitX
      : wf.threeQuoteRequired;
  const filledCount = quotes.filter(
    (q) => q.amount != null && q.companyId,
  ).length;

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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Quotations</CardTitle>
        <p className="text-sm text-muted-foreground">
          {threeQuotesRequired
            ? "Collect quotes from suppliers. Mark one as winning before advancing."
            : "The amount is below the limit — a single quote is enough and is automatically the winning one."}
        </p>
        {threeQuotesRequired && (
          <Alert className="mt-2 border-amber-500/50 text-amber-700 dark:text-amber-400 [&>svg]:text-amber-600">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              The first quote
              {limitX != null ? (
                <>
                  {" "}exceeds the configured limit of{" "}
                  <strong>
                    {limitX} {wf.currency ?? "EUR"}
                  </strong>
                </>
              ) : (
                <> exceeds the configured limit</>
              )}
              . Please collect <strong>three quotes</strong> from different
              suppliers before advancing ({filledCount}/3 entered).
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
              <Label className="text-xs">Supplier</Label>
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
            <div className="col-span-3 space-y-1">
              <Label className="text-xs">Amount</Label>
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
              <Label className="text-xs">Currency</Label>
              <Input
                value={q.currency ?? ""}
                onChange={(e) =>
                  update(idx, { currency: e.target.value.toUpperCase() })
                }
                maxLength={3}
                data-testid={`input-currency-${idx}`}
              />
            </div>
            <div className="col-span-2 space-y-1">
              <Label className="text-xs">Winning</Label>
              {threeQuotesRequired ? (
                <Button
                  type="button"
                  variant={q.winning ? "default" : "outline"}
                  className="w-full"
                  size="sm"
                  onClick={() => setWinning(idx)}
                  data-testid={`button-winning-${idx}`}
                >
                  {q.winning ? "Selected" : "Mark"}
                </Button>
              ) : (
                <div
                  className="flex h-9 w-full items-center justify-center rounded-md border bg-muted/50 text-xs text-muted-foreground"
                  data-testid={`text-winning-auto-${idx}`}
                >
                  {idx === 0 ? "Auto" : "—"}
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
                <Label className="text-xs">Quote documents</Label>
                <div className="flex items-center gap-2">
                  {uploadingIdx === idx && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> Uploading…
                    </span>
                  )}
                  <Label
                    htmlFor={`quote-file-${idx}`}
                    className="inline-flex cursor-pointer items-center gap-1 rounded border bg-background px-2 py-1 text-xs hover:bg-muted"
                    data-testid={`button-upload-quote-${idx}`}
                  >
                    <Upload className="h-3 w-3" /> Attach file
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
                      No file attached yet.
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
            <Plus className="mr-2 h-4 w-4" /> Add quote
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
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function WinningQuoteCard({ wf }: { wf: Workflow }) {
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
          No winning quote selected yet. Go back to the Quotation step and
          mark one quote as winning.
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
  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Winning quote</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <div className="text-xs text-muted-foreground">Reseller</div>
            <div
              className="font-medium"
              data-testid="text-winning-supplier"
            >
              {supplierName}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Amount</div>
            <div
              className="font-medium"
              data-testid="text-winning-amount"
            >
              {winning.amount != null
                ? `${winning.amount} ${winning.currency ?? wf.currency ?? ""}`
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
            Quote documents
          </div>
          {winningDocs.length === 0 ? (
            <p className="text-xs italic text-muted-foreground">
              No file was attached to the winning quote.
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
  // Approve here is a two-step action: persist managerApproved=true and
  // the comment, then immediately advance the workflow to the next step
  // (same effect as clicking the global "Next Step" button afterwards).
  const advance = useAdvanceWorkflow({
    mutation: {
      onSuccess: () => onChange(),
      onError: (err) => {
        const msg =
          (err as { data?: { message?: string } }).data?.message ??
          (err as Error).message;
        alert(`Cannot advance: ${msg}`);
      },
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
          <CardTitle>Department Manager Validation</CardTitle>
          <p className="text-sm text-muted-foreground">
            Approve to send this request on to Financial review, or
            reject to close it. Rejecting closes the workflow.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>Comment</Label>
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
              Approve
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (
                  !confirm(
                    "Reject and close this workflow? This action can be undone by an Admin or Financial-All user.",
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
              Reject &amp; close
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
  const advance = useAdvanceWorkflow({
    mutation: {
      onSuccess: () => onChange(),
      onError: (err) => {
        const msg =
          (err as { data?: { message?: string } }).data?.message ??
          (err as Error).message;
        alert(`Cannot advance: ${msg}`);
      },
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

  function approveAndAdvance() {
    if (!branch) return;
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
        "Reject and close this workflow? This action can be undone by an Admin or Financial-All user.",
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
          <CardTitle>Financial Approval</CardTitle>
          <p className="text-sm text-muted-foreground">
            Pick a routing branch — K-Order or GT Invest — and approve to
            send the workflow forward. Approval is implicit when you choose
            a branch.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Routing branch *</Label>
            <Select
              value={branch}
              onValueChange={(v) =>
                setBranch(v as keyof typeof AdvanceWorkflowInputBranch)
              }
            >
              <SelectTrigger
                className="w-full sm:w-64"
                data-testid="select-fin-branch"
              >
                <SelectValue placeholder="Choose K-Order or GT Invest…" />
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
            <Label>Comment</Label>
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
              Approve &amp; route
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
              Reject
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
  const { data: results } = useListGtInvestResults();
  const [dateId, setDateId] = useState<string>(
    wf.gtInvestDateId ? String(wf.gtInvestDateId) : "",
  );
  const [resultId, setResultId] = useState<string>(
    wf.gtInvestResultId ? String(wf.gtInvestResultId) : "",
  );
  const [comment, setComment] = useState<string>(wf.gtInvestComment ?? "");
  const save = useSaveWorkflow(wf, onChange);
  return (
    <Card>
      <CardHeader>
        <CardTitle>GT Invest Decision</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Meeting date</Label>
            <Select value={dateId} onValueChange={setDateId}>
              <SelectTrigger data-testid="select-gt-date">
                <SelectValue placeholder="Pick a meeting date" />
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
          <div className="space-y-1">
            <Label>Decision</Label>
            <Select value={resultId} onValueChange={setResultId}>
              <SelectTrigger data-testid="select-gt-result">
                <SelectValue placeholder="Pick a result" />
              </SelectTrigger>
              <SelectContent>
                {(results ?? []).map((r) => (
                  <SelectItem key={r.id} value={String(r.id)}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1">
          <Label>Comment</Label>
          <Textarea
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="input-gt-comment"
          />
        </div>
        <Button
          onClick={() =>
            save.mutate({
              id: wf.id,
              data: {
                gtInvestDateId: dateId ? Number(dateId) : null,
                gtInvestResultId: resultId ? Number(resultId) : null,
                gtInvestComment: comment,
              },
            })
          }
          disabled={save.isPending}
          data-testid="button-save-gt"
        >
          <Save className="mr-2 h-4 w-4" /> Save
        </Button>
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
  const [orderNumber, setOrderNumber] = useState(wf.orderNumber ?? "");
  const [orderDate, setOrderDate] = useState(wf.orderDate ?? "");
  const save = useSaveWorkflow(wf, onChange);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Order details</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Order number</Label>
            <Input
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              data-testid="input-order-number"
            />
          </div>
          <div className="space-y-1">
            <Label>Order date</Label>
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
          <Save className="mr-2 h-4 w-4" /> Save
        </Button>
        <StepDocumentUploader
          wf={wf}
          kind="ORDER"
          step="ORDERING"
          label="Order document"
        />
      </CardContent>
    </Card>
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delivery</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label>Delivered on</Label>
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
          <Save className="mr-2 h-4 w-4" /> Save
        </Button>
        <StepDocumentUploader
          wf={wf}
          kind="DELIVERY"
          step="DELIVERY"
          label="Delivery note"
        />
      </CardContent>
    </Card>
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoice details</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label>Invoice number</Label>
            <Input
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              data-testid="input-invoice-number"
            />
          </div>
          <div className="space-y-1">
            <Label>Amount</Label>
            <Input
              type="number"
              step="0.01"
              value={invoiceAmount}
              onChange={(e) => setInvoiceAmount(e.target.value)}
              data-testid="input-invoice-amount"
            />
          </div>
          <div className="space-y-1">
            <Label>Invoice date</Label>
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
          <Save className="mr-2 h-4 w-4" /> Save
        </Button>
        <StepDocumentUploader
          wf={wf}
          kind="INVOICE"
          step="INVOICE"
          label="Invoice document"
        />
      </CardContent>
    </Card>
  );
}

function InvoiceValidationPanel({
  wf,
  onChange,
}: {
  wf: Workflow;
  onChange: () => void;
}) {
  const [signedBy, setSignedBy] = useState(wf.invoiceSignedBy ?? "");
  const save = useSaveWorkflow(wf, onChange);
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
  const busy = save.isPending || reject.isPending;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Validate Invoice</CardTitle>
        <p className="text-sm text-muted-foreground">
          Validate to advance to Payment, or reject to close the
          workflow without paying.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label>Signed by (optional)</Label>
          <Input
            value={signedBy}
            onChange={(e) => setSignedBy(e.target.value)}
            placeholder="Signer name"
            data-testid="input-invoice-signedby"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() =>
              save.mutate({
                id: wf.id,
                data: {
                  invoiceValidated: true,
                  invoiceSignedBy: signedBy || null,
                },
              })
            }
            disabled={busy}
            data-testid="button-invoice-validate"
          >
            {save.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Validate
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (
                !confirm(
                  "Reject this invoice and close the workflow? This action can be undone by an Admin or Financial-All user.",
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
            Reject &amp; close
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PaymentPanel({
  wf,
  onChange,
}: {
  wf: Workflow;
  onChange: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Mark this workflow as paid using <em>Advance</em>. Reference:{" "}
          <span className="font-mono">{wf.reference}</span> · Amount:{" "}
          <strong>
            {wf.invoiceAmount} {wf.currency}
          </strong>
          . Notify finance via the Notes tab if needed.
        </p>
      </CardContent>
    </Card>
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
            <Label className="text-xs">Kind</Label>
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
            <Label className="text-xs">Upload file</Label>
            <Input
              type="file"
              onChange={onPick}
              data-testid="input-file-upload"
            />
          </div>
          {upload.isPending && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Uploading…
            </span>
          )}
        </div>

        <Separator />

        {(docs ?? []).length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No documents uploaded yet.
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
            placeholder="Add a note for this step…"
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
              <Plus className="mr-2 h-4 w-4" /> Add note
            </Button>
          </div>
        </div>
        <Separator />
        {(notes ?? []).length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No notes yet.
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
        <CardTitle>History</CardTitle>
      </CardHeader>
      <CardContent>
        {(hist ?? []).length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No events yet.
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
                    <span className="font-medium">{h.action}</span>
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
