import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ListChecks,
  PenLine,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RTooltip,
  CartesianGrid,
  Cell,
} from "recharts";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useGetDashboardSummary,
  useGetDashboardPendingSignatures,
  type PendingSignature,
} from "@/lib/api";
import { STEP_LABEL, PRIORITY_LABEL, PRIORITY_TONE, type Step } from "@/lib/steps";

function StatCard({
  label,
  value,
  icon: Icon,
  tone = "primary",
  testId,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "primary" | "success" | "warning" | "muted";
  testId: string;
}) {
  const colors = {
    primary: "bg-primary/10 text-primary",
    success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    muted: "bg-muted text-muted-foreground",
  }[tone];

  return (
    <Card data-testid={testId}>
      <CardContent className="flex items-center gap-4 p-5">
        <div
          className={`flex h-12 w-12 items-center justify-center rounded-lg ${colors}`}
        >
          <Icon className="h-6 w-6" />
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            {label}
          </div>
          <div className="mt-0.5 text-2xl font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function PendingSignatureRow({ sig }: { sig: PendingSignature }) {
  const stepLabel = STEP_LABEL[sig.currentStep as Step] ?? sig.currentStep;
  const priorityLabel = PRIORITY_LABEL[sig.priority] ?? sig.priority;
  const priorityTone = PRIORITY_TONE[sig.priority] ?? "";

  return (
    <Link href={`/workflows/${sig.id}`}>
      <div className="flex items-center justify-between gap-3 rounded-md px-3 py-2.5 text-sm hover:bg-muted/50 transition-colors cursor-pointer">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground shrink-0">
              {sig.reference}
            </span>
            <Badge className={`text-[10px] px-1.5 py-0 ${priorityTone}`}>
              {priorityLabel}
            </Badge>
          </div>
          <div className="truncate font-medium mt-0.5">{sig.title}</div>
          <div className="text-xs text-muted-foreground">{sig.departmentName}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-xs font-medium text-primary">{stepLabel}</div>
        </div>
      </div>
    </Link>
  );
}

export function DashboardPage() {
  const { data, isLoading } = useGetDashboardSummary();
  const { data: pending, isLoading: pendingLoading } =
    useGetDashboardPendingSignatures();

  const hasPending = (pending?.length ?? 0) > 0;

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold" data-testid="text-page-title">
          Tableau de bord
        </h1>
        <p className="text-sm text-muted-foreground">
          Vue d'ensemble de toutes les demandes en cours et terminées
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))
        ) : (
          <>
            <StatCard
              label="Demandes actives"
              value={data?.totalActive ?? 0}
              icon={ListChecks}
              tone="primary"
              testId="card-stat-active"
            />
            <StatCard
              label="Terminées"
              value={data?.totalDone ?? 0}
              icon={CheckCircle2}
              tone="success"
              testId="card-stat-done"
            />
            <StatCard
              label="En retard"
              value={data?.stalledCount ?? 0}
              icon={AlertTriangle}
              tone="warning"
              testId="card-stat-stalled"
            />
            <StatCard
              label="Âge moyen (jours)"
              value={Math.round((data?.averageAgeDays ?? 0) * 10) / 10}
              icon={Clock}
              tone="muted"
              testId="card-stat-age"
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Demandes par étape</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-72" />
            ) : (
              <div className="h-72" data-testid="chart-by-step">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={(data?.countsByStep ?? []).map((c) => ({
                      step: STEP_LABEL[c.step as Step],
                      count: c.count,
                    }))}
                    margin={{ top: 8, right: 8, bottom: 36, left: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="hsl(var(--border))"
                    />
                    <XAxis
                      dataKey="step"
                      angle={-25}
                      textAnchor="end"
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      interval={0}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    />
                    <RTooltip
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                      {(data?.countsByStep ?? []).map((_, idx) => (
                        <Cell
                          key={idx}
                          fill={`hsl(var(--chart-${(idx % 5) + 1}))`}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Pending signatures — only shown when the user has a role that
            requires them to sign or approve at least one step */}
        <Card
          className={hasPending ? "border-amber-400 ring-1 ring-amber-300 dark:ring-amber-600" : ""}
          data-testid="card-pending-signatures"
        >
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <PenLine className="h-4 w-4 text-amber-500" />
              Signatures à faire
              {hasPending && (
                <span className="ml-auto rounded-full bg-amber-500 px-2 py-0.5 text-xs font-semibold text-white">
                  {pending!.length}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {pendingLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-14" />
                ))}
              </div>
            ) : !hasPending ? (
              <div className="flex flex-col items-center justify-center py-8 text-center text-sm text-muted-foreground gap-2">
                <CheckCircle2 className="h-8 w-8 text-emerald-500/60" />
                <span>Aucune signature en attente</span>
              </div>
            ) : (
              <div className="divide-y -mx-1">
                {pending!.map((sig) => (
                  <PendingSignatureRow key={sig.id} sig={sig} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
