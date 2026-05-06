import { useState } from "react";
import { Link } from "wouter";
import {
  FileDown,
  CalendarDays,
  Gavel,
  Check,
  X,
  Clock,
  HandshakeIcon,
  Mail,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  useListGtInvestWorkflows,
  useListGtInvestDates,
  useSetGtInvestDecision,
  useNotifyGtInvestMeeting,
  useUpdateWorkflow,
  getListGtInvestWorkflowsQueryKey,
  getListGtInvestDatesQueryKey,
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

      <QueuePanel />
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
  // so reviewers can quickly spot what still needs scheduling. We also
  // pre-seed a group per known meeting date so empty meetings still
  // show up in the overview — handy for planning the next session.
  const dateById = new Map((dates ?? []).map((d) => [d.id, d]));
  type GtMeeting = (NonNullable<typeof dates>)[number];
  const groups = new Map<
    string,
    {
      key: string;
      sortKey: string;
      title: string;
      meeting: GtMeeting | null;
      workflows: NonNullable<typeof rows>;
    }
  >();
  for (const d of dates ?? []) {
    groups.set(`d-${d.id}`, {
      key: `d-${d.id}`,
      sortKey: `0-${d.date}`,
      title: formatMeetingDate(d.date, d.label),
      meeting: d,
      workflows: [],
    });
  }
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
        meeting: meeting ?? null,
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
      <CardHeader>
        <CardTitle>Dossiers GT Invest en attente</CardTitle>
      </CardHeader>
      <CardContent>
        {orderedGroups.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No GT Invest meeting dates yet — add some on the Settings page.
          </p>
        ) : (
          <div className="space-y-6">
            {orderedGroups.map((g) => {
              // A meeting needs (re-)notify whenever it has at least one
              // workflow currently lacking the prepared stamp. This covers
              // both "never prepared" and "new workflows joined after the
              // last send" cases without any extra bookkeeping.
              const needsNotify =
                g.meeting != null &&
                g.workflows.length > 0 &&
                g.workflows.some((w) => !w.gtInvestPreparedAt);
              return (
              <section key={g.key} data-testid={`gt-group-${g.key}`}>
                <div className="mb-2 flex items-center gap-2 flex-wrap">
                  <CalendarDays className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">{g.title}</h3>
                  <Badge variant="outline" className="text-[10px]">
                    {g.workflows.length}
                  </Badge>
                  {g.meeting?.preparedAt && (
                    <Badge
                      variant="secondary"
                      className="text-[10px] gap-1"
                      data-testid={`gt-meeting-prepared-${g.meeting.id}`}
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      Préparé le {new Date(g.meeting.preparedAt).toLocaleString()}
                      {g.meeting.preparedByName
                        ? ` par ${g.meeting.preparedByName}`
                        : ""}
                    </Badge>
                  )}
                  {g.meeting && (
                    <div className="ml-auto flex items-center gap-2">
                      {g.workflows.length > 0 && (
                        <Button asChild variant="outline" size="sm">
                          <a
                            href={`/api/gt-invest/dates/${g.meeting.id}/export`}
                            target="_blank"
                            rel="noreferrer"
                            data-testid={`button-export-pdf-${g.meeting.id}`}
                          >
                            <FileDown className="mr-2 h-3.5 w-3.5" /> Exporter PDF
                          </a>
                        </Button>
                      )}
                      <NotifyMeetingButton
                        dateId={g.meeting.id}
                        disabled={g.workflows.length === 0}
                        needsNotify={needsNotify}
                        alreadyPrepared={g.meeting.preparedAt != null}
                      />
                    </div>
                  )}
                </div>
                {g.workflows.length === 0 ? (
                  <p className="rounded-md border bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
                    No workflows assigned to this meeting yet.
                  </p>
                ) : (
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
                        {w.gtInvestPreparedAt ? (
                          <Badge
                            variant="secondary"
                            className="text-[10px] gap-1"
                            data-testid={`gt-prepared-${w.id}`}
                          >
                            <CheckCircle2 className="h-3 w-3" />
                            Prepared
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="text-[10px] border-amber-400 text-amber-600"
                            data-testid={`gt-pending-${w.id}`}
                          >
                            Awaiting prep
                          </Badge>
                        )}
                        <div className="text-right text-xs text-muted-foreground">
                          {w.ageDays}d old
                        </div>
                        <AssignMeetingSelect
                          workflowId={w.id}
                          currentDateId={w.gtInvestDateId ?? null}
                          dates={dates ?? []}
                        />
                        <DecideButton
                          workflowId={w.id}
                          currentDateId={w.gtInvestDateId ?? null}
                          dates={dates ?? []}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                )}
              </section>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}


// Per-row "Assign to meeting" Select. Lets a GT Invest reviewer move
// a workflow into (or between) meeting buckets without making a
// decision yet — covers the case where a workflow lands at GT_INVEST
// with no meeting attached and the OK / Refused decisions otherwise
// don't touch the date. Reassigning to a different meeting clears
// the prior "prepared" stamp on the server (see PATCH /workflows/:id),
// so the meeting will surface as "needs notify" again.
function AssignMeetingSelect({
  workflowId,
  currentDateId,
  dates,
}: {
  workflowId: number;
  currentDateId: number | null;
  dates: Array<{ id: number; date: string; label?: string | null }>;
}) {
  const qc = useQueryClient();
  const update = useUpdateWorkflow({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListGtInvestWorkflowsQueryKey() });
        qc.invalidateQueries({ queryKey: getListGtInvestDatesQueryKey() });
      },
    },
  });
  // We use a sentinel "none" value to represent "Unassigned" because
  // shadcn's Select cannot use an empty string for an item value.
  const value = currentDateId != null ? String(currentDateId) : "none";
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        const next = v === "none" ? null : Number(v);
        if (next === currentDateId) return;
        update.mutate({
          id: workflowId,
          data: { gtInvestDateId: next },
        });
      }}
      disabled={update.isPending}
    >
      <SelectTrigger
        className="h-8 w-[180px] text-xs"
        data-testid={`select-assign-meeting-${workflowId}`}
      >
        <SelectValue placeholder="Assign to meeting" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">Unassigned</SelectItem>
        {dates.map((d) => (
          <SelectItem key={d.id} value={String(d.id)}>
            {formatMeetingDate(d.date, d.label)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Per-meeting "send the pack now & mark prepared" action. The button
// changes color when there are unprepared workflows in the meeting,
// nudging the operator to re-notify after late additions.
function NotifyMeetingButton({
  dateId,
  disabled,
  needsNotify,
  alreadyPrepared,
}: {
  dateId: number;
  disabled: boolean;
  needsNotify: boolean;
  alreadyPrepared: boolean;
}) {
  const qc = useQueryClient();
  const mutation = useNotifyGtInvestMeeting({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          qc.invalidateQueries({ queryKey: getListGtInvestWorkflowsQueryKey() }),
          qc.invalidateQueries({ queryKey: getListGtInvestDatesQueryKey() }),
        ]);
      },
    },
  });
  const result = mutation.data;
  return (
    <div className="flex items-center gap-2">
      {mutation.isError && (
        <span className="text-xs text-destructive">
          {extractErrorMessage(mutation.error)}
        </span>
      )}
      {result && (
        <span className="text-xs text-muted-foreground">
          {result.sent
            ? `Sent to ${result.recipients.length} recipient(s)`
            : "Stamped (SMTP disabled or no recipients)"}
        </span>
      )}
      <Button
        size="sm"
        variant={needsNotify ? "default" : "outline"}
        disabled={disabled || mutation.isPending}
        onClick={() => mutation.mutate({ id: dateId })}
        data-testid={`button-notify-meeting-${dateId}`}
      >
        {mutation.isPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Mail className="mr-2 h-4 w-4" />
        )}
        {alreadyPrepared
          ? needsNotify
            ? "Re-notify recipients"
            : "Notify again"
          : "Notify recipients & mark prepared"}
      </Button>
    </div>
  );
}
