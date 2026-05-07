import { useState } from "react";
import { Link } from "wouter";
import { Plus, Search, Filter } from "lucide-react";
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
  const [status, setStatus] = useState<"ACTIVE" | "ALL" | "DONE" | "REJECTED">(
    "ACTIVE",
  );
  const params = {
    ...(q ? { q } : {}),
    ...(step !== "ALL" ? { step: step as keyof typeof WorkflowStep } : {}),
    ...(departmentId !== "ALL" ? { departmentId: Number(departmentId) } : {}),
  };
  const { data: workflowsRaw, isLoading } = useListWorkflows(params);
  const { data: departments } = useListDepartments();
  const workflows = (workflowsRaw ?? []).filter((w) => {
    if (status === "ALL") return true;
    if (status === "DONE") return w.currentStep === "DONE";
    if (status === "REJECTED") return w.currentStep === "REJECTED";
    // ACTIVE
    return w.currentStep !== "DONE" && w.currentStep !== "REJECTED";
  });

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
        <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-4">
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
              <SelectItem value="DONE">Terminées</SelectItem>
              <SelectItem value="REJECTED">Clôturées</SelectItem>
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
          ) : workflows.length === 0 ? (
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
