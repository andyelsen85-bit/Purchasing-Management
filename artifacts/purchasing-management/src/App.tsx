import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthGate } from "@/components/AuthGate";
import { AppShell } from "@/components/AppShell";
import { LoginPage } from "@/pages/LoginPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { WorkflowsPage } from "@/pages/WorkflowsPage";
import { NewWorkflowPage } from "@/pages/NewWorkflowPage";
import { WorkflowDetailPage } from "@/pages/WorkflowDetailPage";
import { WorkflowsByStepPage } from "@/pages/WorkflowsByStepPage";
import { GtInvestPage } from "@/pages/GtInvestPage";
import { CompaniesPage } from "@/pages/CompaniesPage";
import { AuditLogPage } from "@/pages/AuditLogPage";
import { SettingsPage } from "@/pages/SettingsPage";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: false },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthGate>
            {(user) => (
              <Switch>
                <Route path="/login" component={LoginPage} />
                <Route>
                  {() => (
                    <AppShell user={user}>
                      <Switch>
                        <Route path="/" component={DashboardPage} />
                        <Route path="/workflows" component={WorkflowsPage} />
                        <Route
                          path="/workflows/new"
                          component={NewWorkflowPage}
                        />
                        <Route path="/workflows/:id">
                          {(params) => (
                            <WorkflowDetailPage
                              id={Number(params.id)}
                              user={user}
                            />
                          )}
                        </Route>
                        <Route
                          path="/workflows-by-step"
                          component={WorkflowsByStepPage}
                        />
                        <Route path="/gt-invest" component={GtInvestPage} />
                        <Route path="/companies" component={CompaniesPage} />
                        <Route path="/audit-log" component={AuditLogPage} />
                        <Route path="/settings" component={SettingsPage} />
                        <Route path="/admin/https">
                          {() => {
                            // Legacy URL — HTTPS / TLS now lives as a tab
                            // inside the unified Settings page.
                            window.history.replaceState(
                              null,
                              "",
                              `${import.meta.env.BASE_URL}settings?tab=https`,
                            );
                            return <SettingsPage />;
                          }}
                        </Route>
                        <Route component={NotFound} />
                      </Switch>
                    </AppShell>
                  )}
                </Route>
              </Switch>
            )}
          </AuthGate>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
