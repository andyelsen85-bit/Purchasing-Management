import { useState } from "react";
import { Link } from "wouter";
import { Plus, Trash2, FileDown, CalendarDays } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
} from "@/lib/api";

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

function QueuePanel() {
  const { data: rows } = useListGtInvestWorkflows();
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
          <div className="divide-y">
            {(rows ?? []).map((w) => (
              <Link key={w.id} href={`/workflows/${w.id}`}>
                <a
                  className="flex items-center justify-between gap-3 py-3 hover-elevate rounded-md px-2"
                  data-testid={`gt-row-${w.id}`}
                >
                  <div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {w.reference}
                    </div>
                    <div className="text-sm font-medium">{w.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {w.departmentName}
                    </div>
                  </div>
                  <div className="text-right">
                    <Badge variant="secondary">
                      {w.estimatedAmount ?? "—"} {w.currency ?? ""}
                    </Badge>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {w.ageDays}d old
                    </div>
                  </div>
                </a>
              </Link>
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

