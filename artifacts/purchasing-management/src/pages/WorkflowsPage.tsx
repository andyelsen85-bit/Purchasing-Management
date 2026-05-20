import { useState, useEffect } from "react";
import { Link } from "wouter";
import { Plus, Search, Filter, FileEdit, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useListWorkflows,
  useListDepartments,
  WorkflowStep,
  type WorkflowSummary,
} from "@/lib/api";
import { STEP_LABEL, PRIORITY_LABEL, PRIORITY_TONE } from "@/lib/steps";

export function WorkflowsPage() {
  const [q, setQ] = useState("");
  const [step, setStep] = useState<string>("ALL");
  const [departmentId, setDepartmentId] = useState<string>("ALL");
  // Active = anything not terminal (DONE / REJECTED). Default view hides
  // finished work because most users only care about what's in flight.
  const [status, setStatus] = useState<"ACTIVE" | "ALL" | "DONE" | "REJECTED" | "DRAFT">(
    "ACTIVE",
  );
  const [filterPriority, setFilterPriority] = useState<string>("ALL");
  const params = {
    ...(q ? { q } : {}),
    ...(step !== "ALL" ? { step: step as keyof typeof WorkflowStep } : {}),
    ...(departmentId !== "ALL" ? { departmentId: Number(departmentId) } : {}),
  };
  const { data: workflowsRaw, isLoading } = useListWorkflows(params);
  const { data: departments } = useListDepartments();

  // Locally-saved draft from the New Workflow page ("Enregistrer comme
  // brouillon" button). Surfaced here so the user can find and resume it —
  // drafts are not persisted server-side, only in this browser.
  const [draft, setDraft] = useState<{ title: string; savedAt?: number } | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("purchasing-workflow-draft");
      if (!raw) {
        setDraft(null);
        return;
      }
      const d = JSON.parse(raw);
      setDraft({ title: typeof d.title === "string" ? d.title : "" });
    } catch {
      setDraft(null);
    }
  }, []);
  function handleDeleteDraft(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    localStorage.removeItem("purchasing-workflow-draft");
    setDraft(null);
  }
  const workflows = (workflowsRaw ?? []).filter((w) => {
    if (status === "DRAFT") return false;
    if (status === "ALL") return true;
    if (status === "DONE") return w.currentStep === "DONE";
    if (status === "REJECTED") return w.currentStep === "REJECTED";
    // ACTIVE
    return w.currentStep !== "DONE" && w.currentStep !== "REJECTED";
  }).filter((w) => filterPriority === "ALL" || w.priority === filterPriority);
  // Only surface the local draft when the status filter includes drafts
  // (ALL or DRAFT). Hide it when viewing Active / Done / Rejected so the
  // draft does not pollute filtered views.
  const showDraft = !!draft && (status === "ALL" || status === "DRAFT");

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-page-title">
            Demandes
          </h1>
          <p className="text-sm text-muted-foreground">
            Toutes les demandes d'achat de l'organisation
          </p>
        </div>
        <Link href="/workflows/new">
          <a>
            <Button data-testid="button-new-workflow">
              <Plus className="mr-2 h-4 w-4" /> Nouvelle demande
            </Button>
          </a>
        </Link>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Filter className="h-4 w-4" /> Filters
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-5">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Rechercher titre ou référence…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-8"
              data-testid="input-search"
            />
          </div>
          <Select value={step} onValueChange={setStep}>
            <SelectTrigger data-testid="select-step">
              <SelectValue placeholder="Étape" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Toutes les étapes</SelectItem>
              {Object.values(WorkflowStep).map((s) => (
                <SelectItem key={s} value={s}>
                  {STEP_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={status}
            onValueChange={(v) => setStatus(v as typeof status)}
          >
            <SelectTrigger data-testid="select-status">
              <SelectValue placeholder="Statut" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ACTIVE">Actives seulement</SelectItem>
              <SelectItem value="ALL">Toutes les demandes</SelectItem>
              <SelectItem value="DRAFT">Brouillons</SelectItem>
              <SelectItem value="DONE">Terminées</SelectItem>
              <SelectItem value="REJECTED">Clôturées</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filterPriority} onValueChange={setFilterPriority}>
            <SelectTrigger data-testid="select-priority">
              <SelectValue placeholder="Priorité" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Toutes les priorités</SelectItem>
              <SelectItem value="NORMAL">Normal</SelectItem>
              <SelectItem value="URGENT">Urgent</SelectItem>
            </SelectContent>
          </Select>
          <Select value={departmentId} onValueChange={setDepartmentId}>
            <SelectTrigger data-testid="select-department">
              <SelectValue placeholder="Service" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Tous les services</SelectItem>
              {(departments ?? []).map((d) => (
                <SelectItem key={d.id} value={String(d.id)}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : workflows.length === 0 && !showDraft ? (
            <div
              className="p-12 text-center text-sm text-muted-foreground"
              data-testid="status-no-workflows"
            >
              Aucune demande trouvée.
            </div>
          ) : (
            <div className="divide-y">
              <div className="grid grid-cols-12 gap-3 px-5 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                <div className="col-span-2">Référence</div>
                <div className="col-span-4">Titre</div>
                <div className="col-span-2">Service</div>
                <div className="col-span-2">Étape</div>
                <div className="col-span-1">Priorité</div>
                <div className="col-span-1 text-right">Âge</div>
              </div>
              {showDraft && (
                <Link href="/workflows/new?resume=1">
                  <a
                    className="grid grid-cols-12 items-center gap-3 px-5 py-3 text-sm hover-elevate bg-amber-50/60 dark:bg-amber-950/20"
                    data-testid="row-draft"
                  >
                    <div className="col-span-2 font-mono text-xs flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                      <FileEdit className="h-3.5 w-3.5" /> Brouillon
                    </div>
                    <div className="col-span-4 font-medium truncate">
                      {draft.title || <span className="italic text-muted-foreground">(sans titre)</span>}
                    </div>
                    <div className="col-span-2 text-muted-foreground truncate">—</div>
                    <div className="col-span-2">
                      <Badge variant="outline" className="text-[11px] border-amber-400 text-amber-700 dark:text-amber-400">
                        Brouillon local
                      </Badge>
                    </div>
                    <div className="col-span-1">—</div>
                    <div className="col-span-1 text-right">
                      <button
                        type="button"
                        onClick={handleDeleteDraft}
                        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label="Supprimer le brouillon"
                        data-testid="button-delete-draft"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </a>
                </Link>
              )}
              {workflows.map((w: WorkflowSummary) => (
                <Link key={w.id} href={`/workflows/${w.id}`}>
                  <a
                    className="grid grid-cols-12 items-center gap-3 px-5 py-3 text-sm hover-elevate"
                    data-testid={`row-workflow-${w.id}`}
                  >
                    <div className="col-span-2 font-mono text-xs">
                      {w.reference}
                    </div>
                    <div className="col-span-4 font-medium truncate">
                      {w.title}
                    </div>
                    <div className="col-span-2 text-muted-foreground truncate">
                      {w.departmentName}
                    </div>
                    <div className="col-span-2">
                      <Badge variant="secondary" className="text-[11px]">
                        {STEP_LABEL[w.currentStep]}
                      </Badge>
                    </div>
                    <div className="col-span-1">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${PRIORITY_TONE[w.priority]}`}
                      >
                        {PRIORITY_LABEL[w.priority]}
                      </span>
                    </div>
                    <div className="col-span-1 text-right text-xs text-muted-foreground">
                      {w.isStalled ? (
                        <span className="font-medium text-amber-600 dark:text-amber-400">
                          {w.ageDays}d ⚠
                        </span>
                      ) : (
                        `${w.ageDays}d`
                      )}
                    </div>
                  </a>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
