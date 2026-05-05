import { Link } from "wouter";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ListChecks,
  ArrowRight,
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useGetDashboardSummary } from "@/lib/api";
import { STEP_LABEL, type Step } from "@/lib/steps";

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

export function DashboardPage() {
  const { data, isLoading } = useGetDashboardSummary();

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold" data-testid="text-page-title">
          Tableau de bord
        </h1>
        <p className="text-sm text-muted-foreground">
          Vue d'ensemble de toutes les commandes en cours et terminées
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
              label="Commandes actives"
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
            <CardTitle>Commandes par étape</CardTitle>
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

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Activité récente</CardTitle>
            <Link href="/workflows">
              <a
                className="flex items-center gap-1 text-xs text-primary hover:underline"
                data-testid="link-all-workflows"
              >
                Tout <ArrowRight className="h-3 w-3" />
              </a>
            </Link>
          </CardHeader>
          <CardContent className="space-y-3 max-h-80 overflow-auto">
            {isLoading ? (
              <Skeleton className="h-40" />
            ) : (data?.recent ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune activité.</p>
            ) : (
              (data?.recent ?? []).map((h) => (
                <div
                  key={h.id}
                  className="flex items-start gap-3 border-b pb-2 last:border-b-0 last:pb-0"
                  data-testid={`activity-${h.id}`}
                >
                  <div className="mt-0.5 flex h-2 w-2 shrink-0 rounded-full bg-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="font-medium">{h.action}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {new Date(h.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {h.actorName}
                      {h.toStep ? ` → ${STEP_LABEL[h.toStep as Step] ?? h.toStep}` : ""}
                    </div>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
