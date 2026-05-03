import { useState } from "react";
import { Link } from "wouter";
import {
  Plus,
  Trash2,
  FileDown,
  CalendarDays,
  Gavel,
  Check,
  X,
  Clock,
  HandshakeIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { extractErrorMessage } from "@/lib/utils";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  useListGtInvestWorkflows,
  useListGtInvestDates,
  useCreateGtInvestDate,
  useDeleteGtInvestDate,
  useSetGtInvestDecision,
  getListGtInvestWorkflowsQueryKey,
} from "@/lib/api";

export type GtInvestDecisionValue =
  | "OK"
  | "REFUSED"
  | "POSTPONED"
  | "ACCORD_PRINCIPE";

export const GT_DECISION_OPTIONS: Array<{
  value: GtInvestDecisionValue;
  label: string;
  short: string;
  needsDate: boolean;
  Icon: React.ComponentType<{ className?: string }>;
  tone: string;
}> = [
  {
    value: "OK",
    label: "OK — approve & move to ordering",
    short: "OK",
    needsDate: false,
    Icon: Check,
    tone: "text-emerald-600",
  },
  {
    value: "REFUSED",
    label: "Refused — close the workflow",
    short: "Refused",
    needsDate: false,
    Icon: X,
    tone: "text-rose-600",
  },
  {
    value: "POSTPONED",
    label: "Postponed — pick a new meeting date",
    short: "Postponed",
    needsDate: true,
    Icon: Clock,
    tone: "text-amber-600",
  },
  {
    value: "ACCORD_PRINCIPE",
    label: "Accord de principe — pick a follow-up meeting date",
    short: "Accord principe",
    needsDate: true,
    Icon: HandshakeIcon,
    tone: "text-sky-600",
  },
];

export function gtDecisionLabel(
  decision: string | null | undefined,
): string | null {
  if (!decision) return null;
  return (
    GT_DECISION_OPTIONS.find((o) => o.value === decision)?.short ?? decision
  );
}

function formatMeetingDate(date: string, label: string | null | undefined) {
  // The API stores meeting dates as ISO date strings (YYYY-MM-DD).
  // Render them in a friendly long form, but keep the raw date as a
  // fallback if parsing fails for any reason.
  let pretty = date;
  try {
    const d = new Date(`${date}T00:00:00`);
    if (!Number.isNaN(d.getTime())) {
      pretty = d.toLocaleDateString(undefined, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    }
  } catch {
    /* fall back to raw date string */
  }
  return label ? `${pretty} — ${label}` : pretty;
}

export function GtInvestPage() {
  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold" data-testid="text-page-title">
          GT Invest
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage GT Invest meeting dates and the queue of workflows pending
          decision.
        </p>
      </header>

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue" data-testid="tab-queue">
            Queue
          </TabsTrigger>
          <TabsTrigger value="dates" data-testid="tab-dates">
            <CalendarDays className="mr-1 h-3.5 w-3.5" /> Dates
          </TabsTrigger>
        </TabsList>

        <TabsContent value="queue">
          <QueuePanel />
        </TabsContent>
        <TabsContent value="dates">
          <DatesPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DecideButton({
  workflowId,
  currentDateId,
  dates,
}: {
  workflowId: number;
  currentDateId: number | null;
  dates: Array<{ id: number; date: string; label?: string | null }>;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<GtInvestDecisionValue | "">("");
  const [dateId, setDateId] = useState<string>(
    currentDateId ? String(currentDateId) : "",
  );
  const [comment, setComment] = useState("");
  const submit = useSetGtInvestDecision({
    mutation: {
      onSuccess: () => {
        // Refresh both the queue and any workflow-summary lists so the
        // moved/closed workflow disappears from the GT Invest queue
        // and shows up under its new step everywhere else.
        qc.invalidateQueries({ queryKey: getListGtInvestWorkflowsQueryKey() });
        qc.invalidateQueries();
        setOpen(false);
        setDecision("");
        setComment("");
      },
    },
  });
  const opt = GT_DECISION_OPTIONS.find((o) => o.value === decision);
  const needsDate = opt?.needsDate ?? false;
  const canSubmit =
    !!decision && (!needsDate || !!dateId) && !submit.isPending;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          data-testid={`button-decide-${workflowId}`}
        >
          <Gavel className="mr-2 h-3.5 w-3.5" /> Decide
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3" align="end">
        <div className="space-y-1">
          <Label className="text-xs">Decision</Label>
          <Select
            value={decision}
            onValueChange={(v) => setDecision(v as GtInvestDecisionValue)}
          >
            <SelectTrigger data-testid={`select-decision-${workflowId}`}>
              <SelectValue placeholder="Pick a decision" />
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
            <Label className="text-xs">Meeting date</Label>
            <Select value={dateId} onValueChange={setDateId}>
              <SelectTrigger data-testid={`select-date-${workflowId}`}>
                <SelectValue placeholder="Pick a meeting date" />
              </SelectTrigger>
              <SelectContent>
                {dates.map((d) => (
                  <SelectItem key={d.id} value={String(d.id)}>
                    {formatMeetingDate(d.date, d.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="space-y-1">
          <Label className="text-xs">Comment (optional)</Label>
          <Textarea
            rows={2}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid={`input-comment-${workflowId}`}
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
          className="w-full"
          disabled={!canSubmit}
          onClick={() => {
            if (!decision) return;
            submit.mutate({
              id: workflowId,
              data: {
                decision,
                dateId: needsDate ? Number(dateId) : null,
                comment: comment || null,
              },
            });
          }}
          data-testid={`button-submit-decision-${workflowId}`}
        >
          Apply decision
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function QueuePanel() {
  const { data: rows } = useListGtInvestWorkflows();
  const { data: dates } = useListGtInvestDates();

  // Group workflows by their assigned GT Invest meeting date. Anything
  // not yet assigned to a date lands in a dedicated "Unassigned" bucket
  // so reviewers can quickly spot what still needs scheduling.
  const dateById = new Map((dates ?? []).map((d) => [d.id, d]));
  const groups = new Map<
    string,
    {
      key: string;
      sortKey: string;
      title: string;
      workflows: NonNullable<typeof rows>;
    }
  >();
  for (const w of rows ?? []) {
    const dateId = w.gtInvestDateId ?? null;
    const meeting = dateId != null ? dateById.get(dateId) : undefined;
    const key = meeting ? `d-${meeting.id}` : "unassigned";
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        // Unassigned bucket sorts last; otherwise sort chronologically.
        sortKey: meeting ? `0-${meeting.date}` : "9",
        title: meeting
          ? formatMeetingDate(meeting.date, meeting.label)
          : "Unassigned",
        workflows: [],
      });
    }
    groups.get(key)!.workflows.push(w);
  }
  const orderedGroups = Array.from(groups.values()).sort((a, b) =>
    a.sortKey.localeCompare(b.sortKey),
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Pending GT Invest workflows</CardTitle>
        <Button asChild variant="outline" size="sm">
          <a
            href="/api/gt-invest/export"
            target="_blank"
            rel="noreferrer"
            data-testid="button-export-pdf"
          >
            <FileDown className="mr-2 h-4 w-4" /> Export merged PDF
          </a>
        </Button>
      </CardHeader>
      <CardContent>
        {(rows ?? []).length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No workflows currently in GT Invest.
          </p>
        ) : (
          <div className="space-y-6">
            {orderedGroups.map((g) => (
              <section key={g.key} data-testid={`gt-group-${g.key}`}>
                <div className="mb-2 flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">{g.title}</h3>
                  <Badge variant="outline" className="text-[10px]">
                    {g.workflows.length}
                  </Badge>
                </div>
                <div className="divide-y rounded-md border">
                  {g.workflows.map((w) => (
                    <div
                      key={w.id}
                      className="flex items-center justify-between gap-3 px-3 py-3"
                      data-testid={`gt-row-${w.id}`}
                    >
                      <Link
                        href={`/workflows/${w.id}`}
                        className="flex-1 hover-elevate rounded-md p-1"
                      >
                        <div className="font-mono text-xs text-muted-foreground">
                          {w.reference}
                        </div>
                        <div className="text-sm font-medium">{w.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {w.departmentName}
                        </div>
                      </Link>
                      <div className="flex items-center gap-3">
                        <div className="text-right text-xs text-muted-foreground">
                          {w.ageDays}d old
                        </div>
                        <DecideButton
                          workflowId={w.id}
                          currentDateId={w.gtInvestDateId ?? null}
                          dates={dates ?? []}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DatesPanel() {
  const { data: dates } = useListGtInvestDates();
  const qc = useQueryClient();
  const create = useCreateGtInvestDate({
    mutation: { onSuccess: () => qc.invalidateQueries() },
  });
  const del = useDeleteGtInvestDate({
    mutation: { onSuccess: () => qc.invalidateQueries() },
  });
  const [date, setDate] = useState("");
  const [label, setLabel] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Meeting dates</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label>Date</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              data-testid="input-gt-date-add"
            />
          </div>
          <div className="space-y-1 flex-1 min-w-48">
            <Label>Label (optional)</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Q3 review"
              data-testid="input-gt-date-label"
            />
          </div>
          <Button
            onClick={() => {
              if (!date) return;
              create.mutate(
                { data: { date, label: label || null } },
                {
                  onSuccess: () => {
                    setDate("");
                    setLabel("");
                  },
                },
              );
            }}
            disabled={!date || create.isPending}
            data-testid="button-add-gt-date"
          >
            <Plus className="mr-2 h-4 w-4" /> Add
          </Button>
        </div>
        {create.error && (
          <Alert variant="destructive" data-testid="alert-gt-date-error">
            <AlertDescription>
              {extractErrorMessage(create.error)}
            </AlertDescription>
          </Alert>
        )}
        <Separator />
        <div className="divide-y">
          {(dates ?? []).map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between py-2"
              data-testid={`row-gt-date-${d.id}`}
            >
              <div>
                <div className="text-sm font-medium">{d.date}</div>
                {d.label && (
                  <div className="text-xs text-muted-foreground">{d.label}</div>
                )}
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => del.mutate({ id: d.id })}
                data-testid={`button-del-gt-date-${d.id}`}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
          {(dates ?? []).length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">
              No dates configured.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

