import { useState, useEffect, useMemo } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  ListChecks,
  Columns3,
  Banknote,
  Building2,
  Settings,
  LogOut,
  Moon,
  Sun,
  FolderTree,
  ChevronRight,
  Plus,
  Eye,
  EyeOff,
  KeyRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useGetSettings,
  useLogout,
  useListDepartments,
  useListWorkflows,
  getGetSessionQueryKey,
  useChangePassword,
} from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import type { SessionUser } from "@/components/AuthGate";
import { STEP_LABEL, PRIORITY_TONE } from "@/lib/steps";
import { useDepartmentFilter } from "@/lib/department-filter";

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles?: string[];
}

// `roles` is a whitelist — when present, only users carrying at least
// one of the listed roles see that nav entry. Items without `roles`
// are visible to everyone signed in. Server-side enforcement still
// runs on every endpoint; this is purely so that operators don't see
// menu items that would 403 the moment they click something inside.
const NAV: NavItem[] = [
  { to: "/", label: "Tableau de bord", icon: LayoutDashboard },
  { to: "/workflows", label: "Demandes", icon: ListChecks },
  { to: "/workflows-by-step", label: "Par étape", icon: Columns3 },
  {
    to: "/gt-invest",
    label: "GT Invest",
    icon: Banknote,
    roles: ["ADMIN", "GT_INVEST", "FINANCIAL_ALL"],
  },
  { to: "/companies", label: "Fournisseurs", icon: Building2 },
  { to: "/settings", label: "Paramètres", icon: Settings, roles: ["ADMIN"] },
];

interface Props {
  user: SessionUser;
  children: React.ReactNode;
}

export function AppShell({ user, children }: Props) {
  const [location, setLocation] = useLocation();
  const { data: settings } = useGetSettings();
  const { data: departments } = useListDepartments();
  const logout = useLogout();
  const qc = useQueryClient();

  // ── Change password dialog ────────────────────────────────────────────────
  const [pwOpen, setPwOpen] = useState(false);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);
  const changePassword = useChangePassword({
    mutation: {
      onSuccess: () => {
        setPwSuccess(true);
        setPwError(null);
        setPwCurrent("");
        setPwNew("");
        setPwConfirm("");
      },
      onError: (err: unknown) => {
        const msg =
          (err as { response?: { data?: { error?: string } } })?.response?.data
            ?.error ?? "Une erreur est survenue.";
        setPwError(msg);
      },
    },
  });

  function openPwDialog() {
    setPwOpen(true);
    setPwCurrent("");
    setPwNew("");
    setPwConfirm("");
    setPwError(null);
    setPwSuccess(false);
  }

  function submitChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    if (pwNew !== pwConfirm) {
      setPwError("Les nouveaux mots de passe ne correspondent pas.");
      return;
    }
    if (pwNew.length < 6) {
      setPwError("Le nouveau mot de passe doit contenir au moins 6 caractères.");
      return;
    }
    changePassword.mutate({ data: { currentPassword: pwCurrent, newPassword: pwNew } });
  }
  // ─────────────────────────────────────────────────────────────────────────
  const [dark, setDark] = useState<boolean>(() => {
    return (
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark")
    );
  });

  // Selected department — shared via context so other pages
  // (Workflows, By Step, …) react to the sidebar selection too.
  const { selectedDeptId, setSelectedDeptId } = useDepartmentFilter();
  const departmentsList = useMemo(() => departments ?? [], [departments]);
  useEffect(() => {
    if (
      selectedDeptId !== "ALL" &&
      !departmentsList.some((d) => d.id === selectedDeptId)
    ) {
      setSelectedDeptId("ALL");
    }
  }, [departmentsList, selectedDeptId]);

  const { data: deptWorkflowsRaw } = useListWorkflows(
    selectedDeptId === "ALL" ? {} : { departmentId: selectedDeptId },
  );
  // The grey "second sidebar" defaults to in-flight work only, but the
  // operator can flip the eye toggle in its header to also list
  // terminal workflows (DONE / REJECTED). Persisted across reloads so
  // a manager who likes seeing the full history doesn't have to re-flip
  // it every time.
  const [showTerminal, setShowTerminal] = useState<boolean>(() => {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem("sidebar-show-terminal") === "1";
  });
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem("sidebar-show-terminal", showTerminal ? "1" : "0");
  }, [showTerminal]);
  const deptWorkflows = useMemo(() => {
    const all = deptWorkflowsRaw ?? [];
    const isTerminal = (s: string) => s === "DONE" || s === "REJECTED";
    const active = all.filter((w) => !isTerminal(w.currentStep));
    if (!showTerminal) return active;
    // Closed/done items are listed AFTER active ones, sorted by their
    // last update time descending so the most recently closed/rejected
    // workflow surfaces at the top of the terminal group.
    const terminal = all
      .filter((w) => isTerminal(w.currentStep))
      .slice()
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    return [...active, ...terminal];
  }, [deptWorkflowsRaw, showTerminal]);
  const hiddenTerminalCount = useMemo(
    () =>
      (deptWorkflowsRaw ?? []).filter(
        (w) => w.currentStep === "DONE" || w.currentStep === "REJECTED",
      ).length,
    [deptWorkflowsRaw],
  );

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    const isDark = saved === "dark";
    document.documentElement.classList.toggle("dark", isDark);
    setDark(isDark);
  }, []);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  }

  function doLogout() {
    logout.mutate(undefined, {
      onSuccess: () => {
        qc.setQueryData(getGetSessionQueryKey(), null);
        qc.clear();
        setLocation("/login");
      },
    });
  }

  const visibleNav = NAV.filter(
    (n) => !n.roles || n.roles.some((r) => user.roles.includes(r)),
  );

  // Show the workflows mini-sidebar only on workflow-related pages.
  const showWorkflowsSidebar =
    location === "/" ||
    location.startsWith("/workflows") ||
    location.startsWith("/gt-invest");

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <ResizablePanelGroup
        direction="horizontal"
        className="h-full"
        autoSaveId="purchasing-shell"
      >
        {/* Primary sidebar: top-level nav + departments tree */}
        <ResizablePanel
          id="primary-sidebar"
          order={1}
          defaultSize={18}
          minSize={14}
          maxSize={28}
          className="bg-sidebar text-sidebar-foreground"
        >
          <div className="flex h-full flex-col" data-testid="sidebar-main">
            <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-white px-1">
                <img
                  src={`${import.meta.env.BASE_URL ?? "/"}logo-chdn.png`}
                  alt="CHdN"
                  className="h-8 w-auto object-contain"
                  data-testid="img-app-logo"
                />
              </div>
              <div className="min-w-0">
                <div
                  className="truncate text-sm font-semibold"
                  data-testid="text-app-name"
                >
                  {settings?.appName ?? "Purchasing Management"}
                </div>
                <div className="text-[11px] uppercase tracking-wider text-sidebar-foreground/60">
                  Procurement Suite
                </div>
              </div>
            </div>

            <ScrollArea className="flex-1 px-2 py-4">
              <nav className="space-y-1">
                {visibleNav.map((item) => {
                  const active =
                    item.to === "/"
                      ? location === "/"
                      : location.startsWith(item.to);
                  return (
                    <Link
                      key={item.to}
                      href={item.to}
                      className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover-elevate ${
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                          : "text-sidebar-foreground/80"
                      }`}
                      data-testid={`link-nav-${item.to.replace(/\//g, "-").replace(/^-/, "") || "home"}`}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
              </nav>

            </ScrollArea>

            <div className="border-t border-sidebar-border p-3">
              <div className="rounded-md bg-sidebar-accent/40 p-3">
                <div
                  className="text-sm font-medium text-sidebar-accent-foreground"
                  data-testid="text-user-name"
                >
                  {user.displayName}
                </div>
                <div className="text-xs text-sidebar-foreground/70">
                  {user.username} · {user.source}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {user.roles.slice(0, 3).map((r) => (
                    <span
                      key={r}
                      className="rounded bg-sidebar/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-sidebar-foreground/80"
                    >
                      {r}
                    </span>
                  ))}
                </div>
              </div>
              <Separator className="my-3 bg-sidebar-border" />
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1 justify-start text-sidebar-foreground/80 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                  onClick={toggleTheme}
                  data-testid="button-toggle-theme"
                >
                  {dark ? (
                    <Sun className="mr-2 h-4 w-4" />
                  ) : (
                    <Moon className="mr-2 h-4 w-4" />
                  )}
                  {dark ? "Clair" : "Sombre"}
                </Button>
                {user.source === "LOCAL" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-sidebar-foreground/80 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                    onClick={openPwDialog}
                    title="Changer le mot de passe"
                    data-testid="button-change-password"
                  >
                    <KeyRound className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-sidebar-foreground/80 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                  onClick={doLogout}
                  data-testid="button-logout"
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </ResizablePanel>

        {false && showWorkflowsSidebar && (
          <>
            <ResizableHandle withHandle />
            {/* Secondary sidebar: workflows for the selected department */}
            <ResizablePanel
              id="workflows-sidebar"
              order={2}
              defaultSize={18}
              minSize={14}
              maxSize={32}
              className="bg-sidebar/60 text-sidebar-foreground"
            >
              <div
                className="flex h-full flex-col"
                data-testid="sidebar-workflows"
              >
                <div className="flex h-16 items-center justify-between gap-2 border-b border-sidebar-border px-4">
                  <div className="min-w-0">
                    <div className="truncate text-xs uppercase tracking-wider text-sidebar-foreground/60">
                      {selectedDeptId === "ALL"
                        ? "All workflows"
                        : (departmentsList.find((d) => d.id === selectedDeptId)
                            ?.name ?? "Department")}
                    </div>
                    <div className="text-sm font-semibold">
                      {(deptWorkflows ?? []).length} item
                      {(deptWorkflows ?? []).length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2"
                      onClick={() => setShowTerminal((v) => !v)}
                      title={
                        showTerminal
                          ? "Hide closed and done workflows"
                          : hiddenTerminalCount > 0
                            ? `Show ${hiddenTerminalCount} closed/done workflow${
                                hiddenTerminalCount === 1 ? "" : "s"
                              }`
                            : "Show closed and done workflows"
                      }
                      aria-pressed={showTerminal}
                      data-testid="button-toggle-terminal-workflows"
                    >
                      {showTerminal ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      asChild
                      size="sm"
                      variant="outline"
                      className="h-8 px-2"
                      data-testid="button-new-workflow-side"
                    >
                      <Link href="/workflows/new">
                        <Plus className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  </div>
                </div>
                <ScrollArea className="flex-1 px-2 py-2">
                  <div className="space-y-1">
                    {(deptWorkflows ?? []).map((w) => {
                      const active = location === `/workflows/${w.id}`;
                      // When the user has the closed/done group
                      // visible, tint the rows so terminal items are
                      // immediately distinguishable from in-flight
                      // ones at a glance: green for DONE, red for
                      // REJECTED. The active row keeps the regular
                      // accent so the selected workflow stands out.
                      const terminalTone = active
                        ? ""
                        : w.currentStep === "DONE"
                          ? "bg-emerald-500/15 text-emerald-100 ring-1 ring-inset ring-emerald-400/30"
                          : w.currentStep === "REJECTED"
                            ? "bg-rose-500/15 text-rose-100 ring-1 ring-inset ring-rose-400/30"
                            : "";
                      return (
                        <Link
                          key={w.id}
                          href={`/workflows/${w.id}`}
                          className={`block rounded-md p-2 text-xs transition-colors hover-elevate ${
                            active
                              ? "bg-sidebar-accent text-sidebar-accent-foreground"
                              : `text-sidebar-foreground/85 ${terminalTone}`
                          }`}
                          data-testid={`link-side-workflow-${w.id}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-[11px] opacity-80">
                              {w.reference}
                            </span>
                            <Badge
                              variant="outline"
                              className={`border-0 px-1.5 py-0 text-[9px] uppercase ${PRIORITY_TONE[w.priority] ?? ""}`}
                            >
                              {w.priority}
                            </Badge>
                          </div>
                          <div className="mt-1 line-clamp-2 text-sm font-medium leading-snug text-sidebar-foreground">
                            {w.title}
                          </div>
                          <div className="mt-1 text-[10px] uppercase tracking-wider text-sidebar-foreground/60">
                            {STEP_LABEL[w.currentStep] ?? w.currentStep}
                          </div>
                        </Link>
                      );
                    })}
                    {(deptWorkflows ?? []).length === 0 && (
                      <div className="px-3 py-6 text-center text-xs text-sidebar-foreground/50">
                        No workflows in this scope.
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </div>
            </ResizablePanel>
          </>
        )}

        <ResizableHandle withHandle />

        <ResizablePanel id="main-content" order={3} defaultSize={64} minSize={40}>
          <main
            className="h-full overflow-auto"
            data-testid="main-content"
          >
            {children}
          </main>
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* ── Change password dialog ─────────────────────────────────────── */}
      <Dialog open={pwOpen} onOpenChange={(o) => { if (!changePassword.isPending) setPwOpen(o); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Changer le mot de passe</DialogTitle>
          </DialogHeader>

          {pwSuccess ? (
            <div className="py-4 text-center text-sm text-green-600 dark:text-green-400">
              Mot de passe modifié avec succès.
            </div>
          ) : (
            <form onSubmit={submitChangePassword} className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="pw-current">Mot de passe actuel</Label>
                <Input
                  id="pw-current"
                  type="password"
                  autoComplete="current-password"
                  value={pwCurrent}
                  onChange={(e) => setPwCurrent(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pw-new">Nouveau mot de passe</Label>
                <Input
                  id="pw-new"
                  type="password"
                  autoComplete="new-password"
                  value={pwNew}
                  onChange={(e) => setPwNew(e.target.value)}
                  required
                  minLength={6}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pw-confirm">Confirmer le nouveau mot de passe</Label>
                <Input
                  id="pw-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={pwConfirm}
                  onChange={(e) => setPwConfirm(e.target.value)}
                  required
                  minLength={6}
                />
              </div>

              {pwError && (
                <p className="text-sm text-destructive">{pwError}</p>
              )}

              <DialogFooter className="pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setPwOpen(false)}
                  disabled={changePassword.isPending}
                >
                  Annuler
                </Button>
                <Button type="submit" disabled={changePassword.isPending}>
                  {changePassword.isPending ? "Enregistrement…" : "Enregistrer"}
                </Button>
              </DialogFooter>
            </form>
          )}

          {pwSuccess && (
            <DialogFooter>
              <Button onClick={() => setPwOpen(false)}>Fermer</Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
