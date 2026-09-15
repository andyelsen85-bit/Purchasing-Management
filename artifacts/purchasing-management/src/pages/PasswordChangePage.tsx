import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { extractErrorMessage } from "@/lib/utils";
import {
  getGetSessionQueryKey,
  useChangePassword,
} from "@/lib/api";

export function PasswordChangePage({ user }: { user: { displayName?: string } }) {
  const qc = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const change = useChangePassword({
    mutation: {
      onSuccess: async () => {
        setError(null);
        await qc.refetchQueries({ queryKey: getGetSessionQueryKey() });
      },
      onError: (err) => setError(extractErrorMessage(err)),
    },
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (newPassword.length < 6) {
      setError("Le nouveau mot de passe doit contenir au moins 6 caractères.");
      return;
    }
    if (newPassword !== confirm) {
      setError("Les nouveaux mots de passe ne correspondent pas.");
      return;
    }
    setError(null);
    change.mutate({ data: { currentPassword, newPassword } });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LockKeyhole className="h-5 w-5" />
            Changement de mot de passe requis
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Bonjour {user.displayName ?? ""}. Choisissez un nouveau mot de passe
            avant d'accéder à InvestFlow.
          </p>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="forced-current-password">Mot de passe temporaire</Label>
              <Input
                id="forced-current-password"
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="forced-new-password">Nouveau mot de passe</Label>
              <Input
                id="forced-new-password"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                minLength={6}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="forced-confirm-password">Confirmer le nouveau mot de passe</Label>
              <Input
                id="forced-confirm-password"
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
                minLength={6}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={change.isPending}>
              {change.isPending ? "Enregistrement…" : "Changer le mot de passe"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}