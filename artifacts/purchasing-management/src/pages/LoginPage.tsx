import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useLogin, useGetSettings, getGetSessionQueryKey } from "@/lib/api";

export function LoginPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { data: settings } = useGetSettings();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [useLdap, setUseLdap] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        const msg =
          (err as { data?: { message?: string } }).data?.message ??
          (err as Error).message ??
          "Login failed";
        setError(msg);
      },
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    login.mutate({ data: { username, password, useLdap } });
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
                onCheckedChange={setUseLdap}
                data-testid="switch-useldap"
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
              Sign in
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Tip: <code>admin / admin</code> for the seeded administrator.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
