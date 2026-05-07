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
import { useLogin, getGetSessionQueryKey } from "@/lib/api";
import { extractErrorMessage } from "@/lib/utils";

interface PublicConfig {
  appName: string;
  logoDataUrl: string | null;
  ldap: { enabled: boolean; kerberosEnabled: boolean };
}

const API_BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

export function LoginPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  const [settings, setSettings] = useState<PublicConfig | null>(null);
  useEffect(() => {
    fetch(`${API_BASE}/api/auth/public-config`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: PublicConfig | null) => setSettings(j))
      .catch(() => setSettings(null));
  }, []);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [useLdap, setUseLdap] = useState(false);
  const [ldapToggleTouched, setLdapToggleTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  useEffect(() => {
    fetch(`${API_BASE}/api/auth/setup-status`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { needsSetup: false }))
      .then((j) => setNeedsSetup(Boolean(j.needsSetup)))
      .catch(() => setNeedsSetup(false));
  }, []);

  const [setupUsername, setSetupUsername] = useState("admin");
  const [setupDisplayName, setSetupDisplayName] = useState("Administrateur");
  const [setupEmail, setSetupEmail] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);

  const ldapEnabled = Boolean(settings?.ldap?.enabled);

  // SSO state: "loading" = waiting for data, "trying" = SPNEGO in flight, "done" = show form
  const [ssoState, setSsoState] = useState<"loading" | "trying" | "done">("loading");
  const ssoTried = useRef(false);

  // Always attempt the silent SPNEGO probe once needsSetup is known.
  // The server decides whether Kerberos is ready:
  //   • Not configured → 401 (no WWW-Authenticate header) → we fall through to the form
  //   • Configured     → 401 + WWW-Authenticate: Negotiate → browser retries with ticket
  //                    → server validates → 200 → we redirect to the app
  // We do NOT gate this on settings.ldap.kerberosEnabled so that an admin who
  // has the browser trusted zone set up but forgot to flip the toggle in Settings
  // still gets a useful fast-fail (the server returns 401 immediately without
  // triggering a browser auth dialog).
  useEffect(() => {
    if (ssoTried.current) return;
    if (needsSetup === null) return; // wait for setup-status

    ssoTried.current = true;

    if (needsSetup) {
      // First-boot wizard — skip SSO entirely
      setSsoState("done");
      return;
    }

    setSsoState("trying");
    const ctrl = new AbortController();
    fetch(`${API_BASE}/api/auth/negotiate`, {
      method: "GET",
      credentials: "include",
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    })
      .then(async (r) => {
        if (!r.ok) return; // any non-200 → fall through to form
        const user = (await r.json()) as { id: number; roles: string[] };
        qc.setQueryData(getGetSessionQueryKey(), { authenticated: true, user });
        setLocation("/");
      })
      .catch(() => {
        /* network error or abort — fall through to form */
      })
      .finally(() => setSsoState("done"));

    return () => ctrl.abort();
  }, [qc, setLocation, needsSetup]);

  const login = useLogin({
    mutation: {
      onSuccess: (res) => {
        qc.setQueryData(getGetSessionQueryKey(), { authenticated: true, user: res });
        setLocation("/");
      },
      onError: (err) => {
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
      setError("Le mot de passe doit contenir au moins 8 caractères.");
      return;
    }
    if (setupPassword !== setupConfirm) {
      setError("Les mots de passe ne correspondent pas.");
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
        setError(j.error ?? `Échec de la configuration (HTTP ${r.status})`);
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

  const isLoading = ssoState === "loading" || ssoState === "trying";

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
            Connectez-vous pour accéder à l'espace de gestion des achats
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div
              className="flex flex-col items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
              data-testid="sso-attempt"
            >
              <Loader2 className="h-5 w-5 animate-spin" />
              {ssoState === "trying"
                ? "Connexion SSO en cours…"
                : "Chargement…"}
            </div>
          ) : needsSetup ? (
            <form className="space-y-4" onSubmit={onSetupSubmit}>
              <Alert>
                <ShieldCheck className="h-4 w-4" />
                <AlertDescription>
                  Bienvenue ! Aucun administrateur n'existe encore. Créez-en un
                  pour terminer la configuration de cette instance.
                </AlertDescription>
              </Alert>
              {error && (
                <Alert variant="destructive" data-testid="alert-setup-error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="setup-username">Nom d'utilisateur</Label>
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
                <Label htmlFor="setup-display">Nom affiché</Label>
                <Input
                  id="setup-display"
                  value={setupDisplayName}
                  onChange={(e) => setSetupDisplayName(e.target.value)}
                  data-testid="input-setup-displayname"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="setup-email">E-mail (optionnel)</Label>
                <Input
                  id="setup-email"
                  type="email"
                  value={setupEmail}
                  onChange={(e) => setSetupEmail(e.target.value)}
                  data-testid="input-setup-email"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="setup-password">Mot de passe</Label>
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
                  Minimum 8 caractères.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="setup-confirm">Confirmer le mot de passe</Label>
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
                Créer l'administrateur
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
                <Label htmlFor="username">Nom d'utilisateur</Label>
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
                <Label htmlFor="password">Mot de passe</Label>
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
                      Utiliser LDAP / Active Directory
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Décochez pour les comptes locaux
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
                Se connecter
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
