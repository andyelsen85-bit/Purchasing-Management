import { useState } from "react";
import { Link } from "wouter";
import { Filter } from "lucide-react";
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
import { useListWorkflowsByStep, useListDepartments } from "@/lib/api";
import { STEP_LABEL, PRIORITY_TONE, type Step } from "@/lib/steps";

export function WorkflowsByStepPage() {
  // Department filter mirrors the one on the Workflows list so the
  // kanban view responds to the same scoping. Sentinel "ALL" means
  // no filter — drop the query param entirely so the server returns
  // every visible workflow.
  const [departmentId, setDepartmentId] = useState<string>("ALL");
  const params =
    departmentId !== "ALL" ? { departmentId: Number(departmentId) } : {};
  const { data, isLoading } = useListWorkflowsByStep(params);
  const { data: departments } = useListDepartments();

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold" data-testid="text-page-title">
          Workflows by step
        </h1>
        <p className="text-sm text-muted-foreground">
          Kanban view: every workflow grouped by its current step
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Filter className="h-4 w-4" /> Filters
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <Select value={departmentId} onValueChange={setDepartmentId}>
            <SelectTrigger data-testid="select-department">
              <SelectValue placeholder="Department" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All departments</SelectItem>
              {(departments ?? []).map((d) => (
                <SelectItem key={d.id} value={String(d.id)}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {(data ?? []).map((group) => (
            <Card key={group.step} data-testid={`column-${group.step}`}>
              <CardContent className="p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-sm font-semibold">
                    {STEP_LABEL[group.step as Step]}
                  </div>
                  <Badge variant="secondary">{group.workflows.length}</Badge>
                </div>
                <div className="space-y-2">
                  {group.workflows.length === 0 && (
                    <p className="py-3 text-center text-xs text-muted-foreground">
                      No workflows
                    </p>
                  )}
                  {group.workflows.map((w) => (
                    <Link key={w.id} href={`/workflows/${w.id}`}>
                      <a
                        className="block rounded-md border bg-card p-3 hover-elevate"
                        data-testid={`card-wf-${w.id}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {w.reference}
                          </span>
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${PRIORITY_TONE[w.priority]}`}
                          >
                            {w.priority}
                          </span>
                        </div>
                        <div className="mt-1 text-sm font-medium leading-snug">
                          {w.title}
                        </div>
                        <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                          <span className="truncate">{w.departmentName}</span>
                          <span>{w.ageDays}d</span>
                        </div>
                      </a>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
