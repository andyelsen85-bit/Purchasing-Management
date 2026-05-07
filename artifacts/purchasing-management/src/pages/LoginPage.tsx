import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock, Package, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useLogin, getGetSessionQueryKey } from "@/lib/api";
import { extractErrorMessage } from "@/lib/utils";

interface PublicConfig {
  appName: string;
  logoDataUrl: string | null;
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
    login.mutate({ data: { username, password } });
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

  if (needsSetup === null) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-900 dark:to-slate-950">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
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
            Connectez-vous pour accéder à l'espace de gestion des achats
          </p>
        </CardHeader>
        <CardContent>
          {needsSetup ? (
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
