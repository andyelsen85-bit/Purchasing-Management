import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock, Package, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useLogin, useGetSettings, getGetSessionQueryKey } from "@/lib/api";
import { extractErrorMessage } from "@/lib/utils";

const API_BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

export function LoginPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { data: settings } = useGetSettings();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // Default the AD toggle to ON whenever LDAP is enabled in Settings.
  // Otherwise operators with an AD account silently land on the local
  // path and get "Invalid credentials" because their AD username has
  // no row in the local users table. They can still flip it off for
  // the local admin account (e.g. break-glass "admin/admin").
  const [useLdap, setUseLdap] = useState(false);
  const [ldapToggleTouched, setLdapToggleTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tryingSso, setTryingSso] = useState(true);
  const ssoTried = useRef(false);

  // First-deployment bootstrap: when the database has no admin yet, the
  // page renders an inline "create administrator" form instead of the
  // login form. The /api/auth/setup endpoint self-disables as soon as
  // any admin exists, so this can never be used to hijack a provisioned
  // instance.
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [setupUsername, setSetupUsername] = useState("admin");
  const [setupDisplayName, setSetupDisplayName] = useState("Administrator");
  const [setupEmail, setSetupEmail] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);
  useEffect(() => {
    fetch(`${API_BASE}/api/auth/setup-status`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { needsSetup: false }))
      .then((j) => setNeedsSetup(Boolean(j.needsSetup)))
      .catch(() => setNeedsSetup(false));
  }, []);

  const ldapEnabled = Boolean(settings?.ldap?.enabled);
  useEffect(() => {
    if (ldapEnabled && !ldapToggleTouched) setUseLdap(true);
  }, [ldapEnabled, ldapToggleTouched]);

  // Silent Kerberos / SPNEGO attempt: when the browser is on a domain-joined
  // machine and configured to send Negotiate tokens for this host, the call
  // succeeds without any user interaction. Any other outcome (401, network
  // error, browser refusing the prompt) just reveals the form fallback below.
  // Skip entirely on first boot (no users yet) and when Kerberos is disabled.
  useEffect(() => {
    if (ssoTried.current) return;
    if (needsSetup === null) return; // wait for setup probe
    ssoTried.current = true;
    if (needsSetup || !settings?.ldap?.kerberosEnabled) {
      setTryingSso(false);
      return;
    }
    const ctrl = new AbortController();
    fetch(`${API_BASE}/api/auth/negotiate`, {
      method: "GET",
      credentials: "include",
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    })
      .then(async (r) => {
        if (!r.ok) return;
        const user = (await r.json()) as { id: number; roles: string[] };
        qc.setQueryData(getGetSessionQueryKey(), {
          authenticated: true,
          user,
        });
        setLocation("/");
      })
      .catch(() => {
        /* fall through to form */
      })
      .finally(() => setTryingSso(false));
    return () => ctrl.abort();
  }, [qc, setLocation, needsSetup, settings?.ldap?.kerberosEnabled]);

  const login = useLogin({
    mutation: {
      onSuccess: (res) => {
        qc.setQueryData(getGetSessionQueryKey(), {
          authenticated: true,
          user: res,
        });
        setLocation("/");
      },
      onError: (err) => {
        // The server returns { error: "<detailed reason>" } in the
        // response body — extractErrorMessage knows to read `.data.error`
        // first so AD bind diagnostics (raw codes, locked / expired
        // accounts, "user not found" hints) actually reach the user
        // instead of being collapsed to "HTTP 401 Unauthorized".
        setError(extractErrorMessage(err));
      },
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    login.mutate({ data: { username, password, useLdap: ldapEnabled && useLdap } });
  }

  async function onSetupSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (setupPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (setupPassword !== setupConfirm) {
      setError("Passwords do not match.");
      return;
    }
    setSetupBusy(true);
    try {
      const r = await fetch(`${API_BASE}/api/auth/setup`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: setupUsername.trim(),
          displayName: setupDisplayName.trim(),
          email: setupEmail.trim() || undefined,
          password: setupPassword,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `Setup failed (HTTP ${r.status})`);
        return;
      }
      const user = await r.json();
      qc.setQueryData(getGetSessionQueryKey(), { authenticated: true, user });
      setLocation("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSetupBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-900 dark:to-slate-950 p-4">
      <Card className="w-full max-w-md shadow-xl" data-testid="card-login">
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            {settings?.logoDataUrl ? (
              <img
                src={settings.logoDataUrl}
                alt=""
                className="h-10 w-10 rounded object-cover"
              />
            ) : (
              <Package className="h-7 w-7" />
            )}
          </div>
          <CardTitle className="text-xl" data-testid="text-login-title">
            {settings?.appName ?? "Purchasing Management"}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Sign in to continue to the procurement workspace
          </p>
        </CardHeader>
        <CardContent>
          {needsSetup === null || tryingSso ? (
            <div
              className="flex flex-col items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
              data-testid="sso-attempt"
            >
              <Loader2 className="h-5 w-5 animate-spin" />
              {needsSetup === null
                ? "Loading…"
                : "Trying single sign-on…"}
            </div>
          ) : needsSetup ? (
            <form className="space-y-4" onSubmit={onSetupSubmit}>
              <Alert>
                <ShieldCheck className="h-4 w-4" />
                <AlertDescription>
                  Welcome! No administrator exists yet. Create one to
                  finish setting up this instance.
                </AlertDescription>
              </Alert>
              {error && (
                <Alert variant="destructive" data-testid="alert-setup-error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="setup-username">Username</Label>
                <Input
                  id="setup-username"
                  autoFocus
                  value={setupUsername}
                  onChange={(e) => setSetupUsername(e.target.value)}
                  required
                  autoComplete="username"
                  data-testid="input-setup-username"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="setup-display">Display name</Label>
                <Input
                  id="setup-display"
                  value={setupDisplayName}
                  onChange={(e) => setSetupDisplayName(e.target.value)}
                  data-testid="input-setup-displayname"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="setup-email">Email (optional)</Label>
                <Input
                  id="setup-email"
                  type="email"
                  value={setupEmail}
                  onChange={(e) => setSetupEmail(e.target.value)}
                  data-testid="input-setup-email"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="setup-password">Password</Label>
                <Input
                  id="setup-password"
                  type="password"
                  value={setupPassword}
                  onChange={(e) => setSetupPassword(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  data-testid="input-setup-password"
                />
                <p className="text-xs text-muted-foreground">
                  Minimum 8 characters.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="setup-confirm">Confirm password</Label>
                <Input
                  id="setup-confirm"
                  type="password"
                  value={setupConfirm}
                  onChange={(e) => setSetupConfirm(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  data-testid="input-setup-confirm"
                />
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={setupBusy}
                data-testid="button-setup-submit"
              >
                {setupBusy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ShieldCheck className="mr-2 h-4 w-4" />
                )}
                Create administrator
              </Button>
            </form>
          ) : (
          <form className="space-y-4" onSubmit={onSubmit}>
            {error && (
              <Alert variant="destructive" data-testid="alert-login-error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
                data-testid="input-username"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                data-testid="input-password"
              />
            </div>
            {ldapEnabled && (
              <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
                <div>
                  <Label htmlFor="useLdap" className="text-sm">
                    Use LDAP / Active Directory
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Disable for local accounts
                  </p>
                </div>
                <Switch
                  id="useLdap"
                  checked={useLdap}
                  onCheckedChange={(v) => {
                    setLdapToggleTouched(true);
                    setUseLdap(v);
                  }}
                  data-testid="switch-useldap"
                />
              </div>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={login.isPending}
              data-testid="button-login-submit"
            >
              {login.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Lock className="mr-2 h-4 w-4" />
              )}
              Sign in
            </Button>
          </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
