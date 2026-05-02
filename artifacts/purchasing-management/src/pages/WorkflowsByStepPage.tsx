import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useListWorkflowsByStep } from "@/lib/api";
import { STEP_LABEL, PRIORITY_TONE, type Step } from "@/lib/steps";

export function WorkflowsByStepPage() {
  const { data, isLoading } = useListWorkflowsByStep();

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
