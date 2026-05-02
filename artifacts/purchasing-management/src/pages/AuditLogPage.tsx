import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useListAuditLog } from "@/lib/api";

export function AuditLogPage() {
  const { data, isLoading } = useListAuditLog({ limit: 200 });
  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold" data-testid="text-page-title">
          Audit log
        </h1>
        <p className="text-sm text-muted-foreground">
          Administrative events: logins, role changes, undo, settings updates,
          and more.
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Recent events (last 200)</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : (data ?? []).length === 0 ? (
            <p className="p-12 text-center text-sm text-muted-foreground">
              No audit entries yet.
            </p>
          ) : (
            <div className="divide-y">
              {(data ?? []).map((e) => (
                <div
                  key={e.id}
                  className="grid grid-cols-12 gap-3 px-4 py-3 text-sm"
                  data-testid={`audit-${e.id}`}
                >
                  <div className="col-span-3 text-xs text-muted-foreground">
                    {new Date(e.createdAt).toLocaleString()}
                  </div>
                  <div className="col-span-2 font-medium">{e.action}</div>
                  <div className="col-span-2 text-muted-foreground">
                    {e.actorName ?? "—"}
                  </div>
                  <div className="col-span-2 text-muted-foreground">
                    {e.target ? `${e.target}#${e.targetId ?? ""}` : "—"}
                  </div>
                  <div className="col-span-3 truncate text-muted-foreground">
                    {e.details}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
