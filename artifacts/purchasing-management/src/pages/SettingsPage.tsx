import { useEffect, useState } from "react";
import {
  Save,
  Loader2,
  Image as ImageIcon,
  Trash2,
  Plus,
  Download,
  Upload,
  ShieldAlert,
  PlugZap,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { extractErrorMessage } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  useGetSettings,
  useUpdateSettings,
  useListDepartments,
  useCreateDepartment,
  useDeleteDepartment,
  useListGtInvestDates,
  useCreateGtInvestDate,
  useDeleteGtInvestDate,
  useListGtInvestResults,
  useCreateGtInvestResult,
  useDeleteGtInvestResult,
  useTestLdap,
} from "@/lib/api";
import { HttpsSettingsPanel } from "@/pages/HttpsPage";

/**
 * Canonical list of app roles + a one-line description of what each role
 * can do. Mirrors `artifacts/api-server/src/lib/permissions.ts` — keep
 * the two in sync. Surfaced verbatim in the Roles tab and used to
 * populate the Group → Role mapping dropdown so admins never have to
 * remember the exact role identifier.
 */
const ROLE_DEFS: Array<{ role: string; label: string; description: string }> = [
  {
    role: "ADMIN",
    label: "Administrator",
    description:
      "Full access to every workflow, every step, every setting. Manages users, departments, LDAP, SMTP, GT Invest, certificates, backup/restore. Can undo any step.",
  },
  {
    role: "FINANCIAL_ALL",
    label: "Financial — full",
    description:
      "Can act on every step of every workflow regardless of department: quotation, financial validation (K-Order/GT-Invest routing), ordering, delivery, invoice, payment. Can undo. Can edit master data (companies, contacts).",
  },
  {
    role: "FINANCIAL_INVOICE",
    label: "Financial — invoicing",
    description:
      "Reads every workflow. Can record the supplier invoice (step 7) and validate the invoice (step 8). Cannot create workflows or place orders.",
  },
  {
    role: "FINANCIAL_PAYMENT",
    label: "Financial — payment",
    description:
      "Reads every workflow. Can mark workflows as paid (step 9). Cannot create workflows or place orders.",
  },
  {
    role: "DEPT_MANAGER",
    label: "Department manager",
    description:
      "Acts on workflows belonging to their department: create, quote, manager validation (step 3), record delivery. Cannot perform financial validation, ordering, invoicing or payment.",
  },
  {
    role: "DEPT_USER",
    label: "Department user",
    description:
      "Acts on workflows belonging to their department: create new requests, attach quotes (step 2), record delivery (step 6). Cannot validate or order.",
  },
  {
    role: "GT_INVEST",
    label: "GT Invest committee",
    description:
      "Acts on the GT Invest review step (step 4b) when a workflow is routed to GT Invest by financial validation.",
  },
  {
    role: "READ_ONLY_DEPT",
    label: "Read-only — department",
    description:
      "Sees workflows belonging to their department but cannot mutate anything (no notes, no documents, no advance, no undo).",
  },
  {
    role: "READ_ONLY_ALL",
    label: "Read-only — all",
    description:
      "Sees every workflow but cannot mutate anything. Useful for auditors and observers.",
  },
];

export function SettingsPage() {
  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold" data-testid="text-page-title">
          Settings
        </h1>
        <p className="text-sm text-muted-foreground">
          Application, branding, LDAP, SMTP, and GT Invest configuration
        </p>
      </header>
      <Tabs defaultValue="app">
        <TabsList>
          <TabsTrigger value="app" data-testid="tab-app">
            Application
          </TabsTrigger>
          <TabsTrigger value="departments" data-testid="tab-departments">
            Departments
          </TabsTrigger>
          <TabsTrigger value="roles" data-testid="tab-roles">
            Roles
          </TabsTrigger>
          <TabsTrigger value="ldap" data-testid="tab-ldap">
            LDAP
          </TabsTrigger>
          <TabsTrigger value="smtp" data-testid="tab-smtp">
            SMTP
          </TabsTrigger>
          <TabsTrigger value="gt" data-testid="tab-gt">
            GT Invest
          </TabsTrigger>
          <TabsTrigger value="https" data-testid="tab-https">
            HTTPS / TLS
          </TabsTrigger>
          <TabsTrigger value="backup" data-testid="tab-backup">
            Backup &amp; Restore
          </TabsTrigger>
        </TabsList>
        <TabsContent value="app">
          <AppSettingsPanel />
        </TabsContent>
        <TabsContent value="departments">
          <DepartmentsPanel />
        </TabsContent>
        <TabsContent value="roles">
          <RolesReferencePanel />
        </TabsContent>
        <TabsContent value="ldap">
          <div className="space-y-4">
            <LdapSettingsPanel />
            <LdapTestPanel />
            <GroupMappingPanel />
          </div>
        </TabsContent>
        <TabsContent value="smtp">
          <SmtpSettingsPanel />
        </TabsContent>
        <TabsContent value="gt">
          <div className="space-y-4">
            <GtRecipientsPanel />
            <GtDatesPanel />
            <GtResultsPanel />
          </div>
        </TabsContent>
        <TabsContent value="https">
          <HttpsSettingsPanel />
        </TabsContent>
        <TabsContent value="backup">
          <BackupRestorePanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function useSaveSettings() {
  const qc = useQueryClient();
  return useUpdateSettings({
    mutation: { onSuccess: () => qc.invalidateQueries() },
  });
}

/**
 * Operator-facing backup & restore. The backend route dumps every
 * persisted table to JSON (documents are stored base64 in-row, so the
 * file is fully self-contained); restoring wipes those tables inside
 * a transaction, replays the dump, and forces every active session to
 * re-authenticate.
 */
function BackupRestorePanel() {
  const apiBase = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  const [busy, setBusy] = useState<"download" | "upload" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  async function downloadBackup() {
    setBusy("download");
    setError(null);
    setSuccess(null);
    try {
      const r = await fetch(`${apiBase}/api/admin/backup`, {
        credentials: "include",
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const cd = r.headers.get("content-disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(cd);
      const filename = m
        ? m[1]
        : `purchasing-backup-${new Date().toISOString()}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setSuccess(`Downloaded ${filename}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setPendingFile(f);
    setConfirming(Boolean(f));
    setError(null);
    setSuccess(null);
    e.target.value = ""; // allow re-selecting same file later
  }

  async function uploadRestore() {
    if (!pendingFile) return;
    setBusy("upload");
    setError(null);
    setSuccess(null);
    setConfirming(false);
    try {
      const fd = new FormData();
      fd.append("file", pendingFile);
      const r = await fetch(`${apiBase}/api/admin/restore`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      const j = (await r.json().catch(() => ({}))) as {
        error?: string;
        restoredRows?: number;
      };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSuccess(
        `Restored ${j.restoredRows ?? 0} rows. You will be signed out — please log in again.`,
      );
      setPendingFile(null);
      // Server already destroyed our session; redirect to login after a
      // short delay so the success message is visible.
      setTimeout(() => {
        window.location.href = `${apiBase}/`;
      }, 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Backup &amp; Restore</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Download backup</h3>
          <p className="text-sm text-muted-foreground">
            Exports every user, department, company, workflow, document,
            note, history entry, audit log, setting, GT Invest data and
            TLS material as a single JSON file. Document files are
            embedded as base64, so this single file is the complete
            snapshot of the instance.
          </p>
          <Button
            onClick={downloadBackup}
            disabled={busy !== null}
            data-testid="button-download-backup"
          >
            {busy === "download" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Download backup
          </Button>
        </div>

        <Separator />

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Restore from backup</h3>
          <Alert variant="destructive">
            <ShieldAlert className="h-4 w-4" />
            <AlertDescription>
              Restoring overwrites <strong>every</strong> table (users,
              workflows, documents, settings, …) with the contents of
              the uploaded file. Any data created since the backup was
              taken will be lost. You will be signed out and must log in
              again with a user from the backup.
            </AlertDescription>
          </Alert>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="file"
              accept="application/json,.json"
              onChange={pickFile}
              disabled={busy !== null}
              data-testid="input-restore-file"
              className="text-sm file:mr-3 file:rounded file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent"
            />
          </div>
          {confirming && pendingFile && (
            <div className="rounded-md border border-destructive bg-destructive/5 p-3 text-sm">
              <p className="mb-2">
                Selected: <strong>{pendingFile.name}</strong> (
                {(pendingFile.size / 1024).toFixed(1)} KB). Click
                Restore to wipe and replace all data.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  onClick={uploadRestore}
                  disabled={busy !== null}
                  data-testid="button-confirm-restore"
                >
                  {busy === "upload" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="mr-2 h-4 w-4" />
                  )}
                  Restore (overwrite everything)
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPendingFile(null);
                    setConfirming(false);
                  }}
                  disabled={busy !== null}
                  data-testid="button-cancel-restore"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>

        {error && (
          <Alert variant="destructive" data-testid="alert-backup-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {success && (
          <Alert data-testid="alert-backup-success">
            <AlertDescription>{success}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function AppSettingsPanel() {
  const { data: s } = useGetSettings();
  const save = useSaveSettings();
  const [appName, setAppName] = useState("");
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [limitX, setLimitX] = useState<number>(10000);
  const [currency, setCurrency] = useState("EUR");
  const [signingEnabled, setSigningEnabled] = useState(false);
  const [signingUrl, setSigningUrl] = useState("");

  useEffect(() => {
    if (!s) return;
    setAppName(s.appName);
    setLogoDataUrl(s.logoDataUrl ?? null);
    setLimitX(s.limitX);
    setCurrency(s.currency);
    setSigningEnabled(s.certSigningEnabled);
    setSigningUrl(s.signingAgentUrl ?? "");
  }, [s]);

  function onLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setLogoDataUrl(String(reader.result || ""));
    reader.readAsDataURL(f);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Application</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>App name</Label>
            <Input
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
              data-testid="input-appname"
            />
          </div>
          <div className="space-y-1">
            <Label>Default currency</Label>
            <Input
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              maxLength={3}
              data-testid="input-currency"
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label>Three-quote requirement above (X)</Label>
            <Input
              type="number"
              value={limitX}
              onChange={(e) => setLimitX(Number(e.target.value))}
              data-testid="input-limitx"
            />
            <p className="text-xs text-muted-foreground">
              When estimated amount is greater than this value, three quotes
              are required.
            </p>
          </div>
        </div>

        <Separator />

        <div className="space-y-1">
          <Label>Logo</Label>
          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-md border bg-muted">
              {logoDataUrl ? (
                <img
                  src={logoDataUrl}
                  alt=""
                  className="h-full w-full rounded object-cover"
                />
              ) : (
                <ImageIcon className="h-6 w-6 text-muted-foreground" />
              )}
            </div>
            <Input
              type="file"
              accept="image/*"
              onChange={onLogo}
              data-testid="input-logo"
            />
            {logoDataUrl && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLogoDataUrl(null)}
                data-testid="button-remove-logo"
              >
                <Trash2 className="mr-2 h-4 w-4 text-destructive" /> Remove
              </Button>
            )}
          </div>
        </div>

        <Separator />

        <div className="space-y-2">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label>Enable Windows signing agent</Label>
              <p className="text-xs text-muted-foreground">
                If enabled, certificate signing requests are forwarded to the
                Windows agent at the URL below.
              </p>
            </div>
            <Switch
              checked={signingEnabled}
              onCheckedChange={setSigningEnabled}
              data-testid="switch-signing-enabled"
            />
          </div>
          {signingEnabled && (
            <Input
              placeholder="https://signing-agent.lan:9443"
              value={signingUrl}
              onChange={(e) => setSigningUrl(e.target.value)}
              data-testid="input-signing-url"
            />
          )}
        </div>

        <div className="flex justify-end">
          <Button
            onClick={() =>
              save.mutate({
                data: {
                  appName,
                  logoDataUrl,
                  limitX,
                  currency,
                  certSigningEnabled: signingEnabled,
                  signingAgentUrl: signingUrl || null,
                },
              })
            }
            disabled={save.isPending}
            data-testid="button-save-app"
          >
            {save.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            <Save className="mr-2 h-4 w-4" /> Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function LdapSettingsPanel() {
  const { data: s } = useGetSettings();
  const save = useSaveSettings();
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(636);
  const [baseDn, setBaseDn] = useState("");
  const [encryption, setEncryption] = useState<"ldaps" | "starttls" | "plain">(
    "ldaps",
  );
  const [bindDn, setBindDn] = useState("");
  const [bindPassword, setBindPassword] = useState("");
  const [skipVerify, setSkipVerify] = useState(false);
  const [caCert, setCaCert] = useState("");
  const [caCertSet, setCaCertSet] = useState(false);
  const [kerberos, setKerberos] = useState(false);
  const [spn, setSpn] = useState("");

  useEffect(() => {
    if (!s) return;
    setEnabled(s.ldap.enabled);
    setHost(s.ldap.host ?? "");
    setPort(s.ldap.port ?? 636);
    setEncryption(
      (s.ldap as { encryption?: "ldaps" | "starttls" | "plain" }).encryption ??
        "ldaps",
    );
    setBaseDn(s.ldap.baseDn ?? "");
    setBindDn(s.ldap.bindDn ?? "");
    setBindPassword("");
    setSkipVerify(s.ldap.skipVerify);
    setCaCert("");
    setCaCertSet(s.ldap.caCertSet);
    setKerberos(s.ldap.kerberosEnabled);
    setSpn(s.ldap.servicePrincipalName ?? "");
  }, [s]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>LDAPS / Kerberos</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border p-3">
          <Label>LDAP enabled</Label>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            data-testid="switch-ldap-enabled"
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Host</Label>
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              data-testid="input-ldap-host"
            />
          </div>
          <div className="space-y-1">
            <Label>Port</Label>
            <Input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              data-testid="input-ldap-port"
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label>Encryption</Label>
            <Select
              value={encryption}
              onValueChange={(v) => {
                const next = v as "ldaps" | "starttls" | "plain";
                setEncryption(next);
                // Auto-suggest the standard port for the new mode if the
                // operator hasn't customised it.
                if (next === "ldaps" && (port === 389 || !port)) setPort(636);
                if (next !== "ldaps" && (port === 636 || !port)) setPort(389);
              }}
            >
              <SelectTrigger data-testid="select-ldap-encryption">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ldaps">
                  LDAPS — implicit TLS (port 636)
                </SelectItem>
                <SelectItem value="starttls">
                  StartTLS — upgrade plain 389 to TLS
                </SelectItem>
                <SelectItem value="plain">
                  Plain LDAP — no encryption (diagnostic only)
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              If you see <code>ECONNRESET</code> when testing, the encryption
              mode usually doesn&apos;t match the server&apos;s port.
            </p>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label>Base DN</Label>
            <Input
              value={baseDn}
              onChange={(e) => setBaseDn(e.target.value)}
              data-testid="input-ldap-basedn"
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label>Bind DN</Label>
            <Input
              value={bindDn}
              onChange={(e) => setBindDn(e.target.value)}
              data-testid="input-ldap-binddn"
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label>Bind password</Label>
            <Input
              type="password"
              value={bindPassword}
              onChange={(e) => setBindPassword(e.target.value)}
              placeholder="(unchanged)"
              data-testid="input-ldap-bindpw"
            />
            <p className="text-xs text-muted-foreground">
              Leave empty to keep the current password.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between rounded-md border p-3">
          <Label>Skip TLS verification</Label>
          <Switch
            checked={skipVerify}
            onCheckedChange={setSkipVerify}
            data-testid="switch-skip-verify"
          />
        </div>
        <div className="space-y-1">
          <Label>CA certificate (PEM)</Label>
          <Textarea
            value={caCert}
            onChange={(e) => setCaCert(e.target.value)}
            placeholder={
              caCertSet
                ? "(stored — paste a new PEM to replace, leave empty to keep)"
                : "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"
            }
            rows={6}
            className="font-mono text-xs"
            data-testid="input-ldap-cacert"
          />
          <p className="text-xs text-muted-foreground">
            Paste the PEM-encoded CA used to sign your domain
            controller&apos;s LDAPS certificate. Required when the issuing CA
            is not in the public trust store and TLS verification is on.
          </p>
        </div>
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label>Enable Kerberos / GSSAPI</Label>
            <p className="text-xs text-muted-foreground">
              Negotiate single sign-on for Windows clients
            </p>
          </div>
          <Switch
            checked={kerberos}
            onCheckedChange={setKerberos}
            data-testid="switch-kerberos"
          />
        </div>
        {kerberos && (
          <div className="space-y-1">
            <Label>Service principal name</Label>
            <Input
              value={spn}
              onChange={(e) => setSpn(e.target.value)}
              placeholder="HTTP/host.domain.lan"
              data-testid="input-spn"
            />
          </div>
        )}
        <div className="flex justify-end">
          <Button
            onClick={() =>
              save.mutate({
                data: {
                  ldap: {
                    enabled,
                    host: host || null,
                    port,
                    encryption,
                    baseDn: baseDn || null,
                    bindDn: bindDn || null,
                    ...(bindPassword ? { bindPassword } : {}),
                    skipVerify,
                    ...(caCert.trim() ? { caCert: caCert.trim() } : {}),
                    kerberosEnabled: kerberos,
                    servicePrincipalName: spn || null,
                  },
                },
              })
            }
            disabled={save.isPending}
            data-testid="button-save-ldap"
          >
            {save.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            <Save className="mr-2 h-4 w-4" /> Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SmtpSettingsPanel() {
  const { data: s } = useGetSettings();
  const save = useSaveSettings();
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(465);
  const [secure, setSecure] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fromAddress, setFromAddress] = useState("");

  useEffect(() => {
    if (!s) return;
    setEnabled(s.smtp.enabled);
    setHost(s.smtp.host ?? "");
    setPort(s.smtp.port ?? 465);
    setSecure(s.smtp.secure);
    setUsername(s.smtp.username ?? "");
    setPassword("");
    setFromAddress(s.smtp.fromAddress ?? "");
  }, [s]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>SMTP</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border p-3">
          <Label>Email enabled</Label>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            data-testid="switch-smtp-enabled"
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Host</Label>
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              data-testid="input-smtp-host"
            />
          </div>
          <div className="space-y-1">
            <Label>Port</Label>
            <Input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              data-testid="input-smtp-port"
            />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3 sm:col-span-2">
            <Label>Use TLS (secure)</Label>
            <Switch
              checked={secure}
              onCheckedChange={setSecure}
              data-testid="switch-smtp-secure"
            />
          </div>
          <div className="space-y-1">
            <Label>Username</Label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              data-testid="input-smtp-user"
            />
          </div>
          <div className="space-y-1">
            <Label>Password</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="(unchanged)"
              data-testid="input-smtp-pw"
            />
          </div>
          <div className="space-y-1">
            <Label>From address</Label>
            <Input
              type="email"
              value={fromAddress}
              onChange={(e) => setFromAddress(e.target.value)}
              data-testid="input-smtp-from"
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            onClick={() =>
              save.mutate({
                data: {
                  smtp: {
                    enabled,
                    host: host || null,
                    port,
                    secure,
                    username: username || null,
                    ...(password ? { password } : {}),
                    fromAddress: fromAddress || null,
                  },
                },
              })
            }
            disabled={save.isPending}
            data-testid="button-save-smtp"
          >
            {save.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            <Save className="mr-2 h-4 w-4" /> Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DepartmentsPanel() {
  const qc = useQueryClient();
  const { data: depts } = useListDepartments();
  const create = useCreateDepartment({
    mutation: { onSuccess: () => qc.invalidateQueries() },
  });
  const del = useDeleteDepartment({
    mutation: { onSuccess: () => qc.invalidateQueries() },
  });
  const [code, setCode] = useState("");
  const [name, setName] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Departments</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[160px_1fr_auto]">
          <Input
            placeholder="Code (e.g. IT)"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            data-testid="input-dept-code"
          />
          <Input
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="input-dept-name"
          />
          <Button
            onClick={() => {
              if (!code.trim() || !name.trim()) return;
              create.mutate(
                { data: { code: code.trim(), name: name.trim() } },
                {
                  onSuccess: () => {
                    setCode("");
                    setName("");
                  },
                },
              );
            }}
            disabled={create.isPending}
            data-testid="button-add-dept"
          >
            <Plus className="mr-2 h-4 w-4" /> Add
          </Button>
        </div>
        <Separator />
        {(depts ?? []).length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            No departments yet.
          </p>
        ) : (
          <div className="divide-y">
            {(depts ?? []).map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-3 py-2"
                data-testid={`dept-row-${d.id}`}
              >
                <code className="rounded bg-muted px-2 py-0.5 text-xs">
                  {d.code}
                </code>
                <span className="flex-1 text-sm">{d.name}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => del.mutate({ id: d.id })}
                  disabled={del.isPending}
                  data-testid={`button-delete-dept-${d.id}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RolesReferencePanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Role definitions</CardTitle>
        <p className="text-sm text-muted-foreground">
          Reference for what each app role is allowed to do. Use these
          identifiers when mapping AD groups to roles in the LDAP tab.
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Role</th>
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 font-medium">What this role can do</th>
              </tr>
            </thead>
            <tbody>
              {ROLE_DEFS.map((r) => (
                <tr
                  key={r.role}
                  className="border-b align-top last:border-0"
                  data-testid={`role-row-${r.role}`}
                >
                  <td className="py-2 pr-4">
                    <code className="rounded bg-muted px-2 py-0.5 text-xs">
                      {r.role}
                    </code>
                  </td>
                  <td className="py-2 pr-4 font-medium">{r.label}</td>
                  <td className="py-2 text-muted-foreground">{r.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function LdapTestPanel() {
  const { data: s } = useGetSettings();
  const test = useTestLdap();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // The mutation result is typed as `unknown` because the OpenAPI
  // response is generic JSON; narrow it here for the UI.
  type TestResult = {
    ok: boolean;
    stage: string;
    error?: string | null;
    displayName?: string | null;
    email?: string | null;
    groups?: string[];
    derivedRoles?: string[];
    derivedDepartmentCodes?: string[];
  };
  const result = test.data as TestResult | undefined;
  const enabled = Boolean(s?.ldap.enabled);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlugZap className="h-4 w-4" /> Test LDAP connection
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Save your LDAP configuration first, then run this test to
          confirm the server is reachable, the bind credentials work,
          and the AD group mapping resolves the expected roles and
          departments. Leave the password empty to do a search-only
          probe with the bind account; supply both username + password
          to perform the exact same flow as a real LDAP sign-in.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!enabled && (
          <Alert>
            <AlertDescription>
              LDAP is currently disabled — turn it on and save above
              before testing, otherwise the test will report
              &quot;not configured&quot;.
            </AlertDescription>
          </Alert>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Test username (sAMAccountName)</Label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. jdoe"
              data-testid="input-ldap-test-username"
            />
          </div>
          <div className="space-y-1">
            <Label>Test password (optional)</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="(leave empty for search-only)"
              data-testid="input-ldap-test-password"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() =>
              test.mutate({
                data: {
                  username: username || null,
                  password: password || null,
                },
              })
            }
            disabled={test.isPending}
            data-testid="button-ldap-test"
          >
            {test.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <PlugZap className="mr-2 h-4 w-4" />
            )}
            Run test
          </Button>
          {result && (
            <span
              className={`flex items-center gap-1 text-sm ${
                result.ok ? "text-emerald-700" : "text-destructive"
              }`}
              data-testid="ldap-test-status"
            >
              {result.ok ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <XCircle className="h-4 w-4" />
              )}
              {result.ok ? "Success" : "Failed"}
              <span className="text-muted-foreground">({result.stage})</span>
            </span>
          )}
        </div>
        {result && (
          <div
            className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm"
            data-testid="ldap-test-result"
          >
            {result.error && (
              <p className="text-destructive">
                <strong>Error:</strong> {result.error}
              </p>
            )}
            {result.displayName && (
              <p>
                <strong>Display name:</strong> {result.displayName}
              </p>
            )}
            {result.email && (
              <p>
                <strong>Email:</strong> {result.email}
              </p>
            )}
            {result.groups && result.groups.length > 0 && (
              <div>
                <strong>AD group memberships ({result.groups.length}):</strong>
                <ul className="mt-1 max-h-40 overflow-auto space-y-0.5 font-mono text-xs">
                  {result.groups.map((g) => (
                    <li key={g} className="break-all">
                      {g}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <strong>Derived roles:</strong>{" "}
                {result.derivedRoles && result.derivedRoles.length > 0 ? (
                  result.derivedRoles.map((r) => (
                    <code
                      key={r}
                      className="mr-1 rounded bg-background px-1.5 py-0.5 text-xs"
                    >
                      {r}
                    </code>
                  ))
                ) : (
                  <span className="text-muted-foreground">
                    (none — check Group → Role mapping)
                  </span>
                )}
              </div>
              <div>
                <strong>Derived departments:</strong>{" "}
                {result.derivedDepartmentCodes &&
                result.derivedDepartmentCodes.length > 0 ? (
                  result.derivedDepartmentCodes.map((c) => (
                    <code
                      key={c}
                      className="mr-1 rounded bg-background px-1.5 py-0.5 text-xs"
                    >
                      {c}
                    </code>
                  ))
                ) : (
                  <span className="text-muted-foreground">
                    (none — check Group → Department mapping)
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GroupMappingPanel() {
  const { data: s } = useGetSettings();
  const { data: depts } = useListDepartments();
  const save = useSaveSettings();
  const [roleMap, setRoleMap] = useState<Record<string, string>>({});
  const [deptMap, setDeptMap] = useState<Record<string, string>>({});
  const [rk, setRk] = useState("");
  const [rv, setRv] = useState("");
  const [dk, setDk] = useState("");
  const [dv, setDv] = useState("");

  useEffect(() => {
    if (!s) return;
    setRoleMap((s.ldap.groupRoleMap ?? {}) as Record<string, string>);
    setDeptMap((s.ldap.groupDepartmentMap ?? {}) as Record<string, string>);
  }, [s]);

  function roleLabel(role: string): string {
    return ROLE_DEFS.find((r) => r.role === role)?.label ?? role;
  }
  function deptLabel(code: string): string {
    return depts?.find((d) => d.code === code)?.name ?? code;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>AD groups → roles &amp; departments</CardTitle>
        <p className="text-sm text-muted-foreground">
          Map LDAP / Active Directory group names (substring or CN) to
          the app roles and departments listed below. The mapping is
          applied on every sign-in, so removing a user from an AD group
          revokes the corresponding role or department on their next
          login. See the <strong>Roles</strong> tab for what each role
          can do.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label className="text-sm font-medium">Map an AD group to a role</Label>
          <p className="text-xs text-muted-foreground">
            The group key matches case-insensitively against the full DN
            or the CN (e.g. <code>Purchasing-Admins</code> matches{" "}
            <code>CN=Purchasing-Admins,OU=Groups,DC=corp,DC=lan</code>).
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_240px_auto]">
            <Input
              placeholder="AD group key (substring or CN)"
              value={rk}
              onChange={(e) => setRk(e.target.value)}
              data-testid="input-grm-key"
            />
            <Select value={rv} onValueChange={setRv}>
              <SelectTrigger data-testid="select-grm-role">
                <SelectValue placeholder="Choose role…" />
              </SelectTrigger>
              <SelectContent>
                {ROLE_DEFS.map((r) => (
                  <SelectItem key={r.role} value={r.role}>
                    {r.label}{" "}
                    <span className="text-xs text-muted-foreground">
                      ({r.role})
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => {
                if (!rk.trim() || !rv.trim()) return;
                setRoleMap((m) => ({ ...m, [rk.trim()]: rv.trim() }));
                setRk("");
                setRv("");
              }}
              data-testid="button-grm-add"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <div className="space-y-1">
            {Object.entries(roleMap).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No mappings yet. Without any role mapping, every signing-in
                LDAP user receives only the <code>DEPT_USER</code> role.
              </p>
            ) : (
              Object.entries(roleMap).map(([k, v]) => (
                <div
                  key={k}
                  className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm"
                  data-testid={`grm-row-${k}`}
                >
                  <span>
                    <code className="text-xs">{k}</code> →{" "}
                    <strong>{roleLabel(v)}</strong>{" "}
                    <span className="text-xs text-muted-foreground">({v})</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      setRoleMap((m) => {
                        const n = { ...m };
                        delete n[k];
                        return n;
                      })
                    }
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
        <Separator />
        <div className="space-y-2">
          <Label className="text-sm font-medium">
            Map an AD group to a department
          </Label>
          <p className="text-xs text-muted-foreground">
            Department membership controls which workflows a user sees
            (unless the role grants global visibility). Add departments
            in the <strong>Departments</strong> tab if your choice isn&apos;t
            in the list.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_240px_auto]">
            <Input
              placeholder="AD group key (substring or CN)"
              value={dk}
              onChange={(e) => setDk(e.target.value)}
              data-testid="input-gdm-key"
            />
            <Select value={dv} onValueChange={setDv}>
              <SelectTrigger data-testid="select-gdm-dept">
                <SelectValue placeholder="Choose department…" />
              </SelectTrigger>
              <SelectContent>
                {(depts ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.code}>
                    {d.name}{" "}
                    <span className="text-xs text-muted-foreground">
                      ({d.code})
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => {
                if (!dk.trim() || !dv.trim()) return;
                setDeptMap((m) => ({ ...m, [dk.trim()]: dv.trim() }));
                setDk("");
                setDv("");
              }}
              data-testid="button-gdm-add"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <div className="space-y-1">
            {Object.entries(deptMap).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No mappings yet. Without department mapping, manually
                assigned department memberships are preserved on each
                login.
              </p>
            ) : (
              Object.entries(deptMap).map(([k, v]) => (
                <div
                  key={k}
                  className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm"
                  data-testid={`gdm-row-${k}`}
                >
                  <span>
                    <code className="text-xs">{k}</code> →{" "}
                    <strong>{deptLabel(v)}</strong>{" "}
                    <span className="text-xs text-muted-foreground">({v})</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      setDeptMap((m) => {
                        const n = { ...m };
                        delete n[k];
                        return n;
                      })
                    }
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            onClick={() =>
              save.mutate({
                data: {
                  ldap: {
                    groupRoleMap: roleMap,
                    groupDepartmentMap: deptMap,
                  },
                },
              })
            }
            disabled={save.isPending}
            data-testid="button-save-mapping"
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Save className="mr-2 h-4 w-4" /> Save mapping
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function GtDatesPanel() {
  const qc = useQueryClient();
  const { data: dates } = useListGtInvestDates();
  const create = useCreateGtInvestDate({
    mutation: { onSuccess: () => qc.invalidateQueries() },
  });
  const del = useDeleteGtInvestDate({
    mutation: { onSuccess: () => qc.invalidateQueries() },
  });
  const [date, setDate] = useState("");
  const [label, setLabel] = useState("");

  const createErr = create.error
    ? extractErrorMessage(create.error)
    : null;
  const delErr = del.error ? extractErrorMessage(del.error) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>GT Invest meeting dates</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-[180px_1fr_auto] gap-2">
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            data-testid="input-gt-date"
          />
          <Input
            placeholder="Label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            data-testid="input-gt-date-label"
          />
          <Button
            onClick={() => {
              if (!date) return;
              create.mutate(
                { data: { date, label: label || undefined } },
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
        {createErr && (
          <Alert variant="destructive" data-testid="alert-gt-date-error">
            <AlertDescription>{createErr}</AlertDescription>
          </Alert>
        )}
        {delErr && (
          <Alert variant="destructive">
            <AlertDescription>{delErr}</AlertDescription>
          </Alert>
        )}
        <Separator />
        {(dates ?? []).length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            No meeting dates configured.
          </p>
        ) : (
          <div className="divide-y">
            {(dates ?? []).map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-3 py-2 text-sm"
                data-testid={`gt-date-row-${d.id}`}
              >
                <strong>{String(d.date)}</strong>
                <span className="flex-1 text-muted-foreground">
                  {d.label ?? ""}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => del.mutate({ id: d.id })}
                  disabled={del.isPending}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GtResultsPanel() {
  const qc = useQueryClient();
  const { data: results } = useListGtInvestResults();
  const create = useCreateGtInvestResult({
    mutation: { onSuccess: () => qc.invalidateQueries() },
  });
  const del = useDeleteGtInvestResult({
    mutation: { onSuccess: () => qc.invalidateQueries() },
  });
  const [label, setLabel] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle>GT Invest result options</CardTitle>
        <p className="text-xs text-muted-foreground">
          Outcomes the GT Invest committee can record on a workflow.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Input
            placeholder="Label (e.g. Approved)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            data-testid="input-gt-result-label"
          />
          <Button
            onClick={() => {
              if (!label.trim()) return;
              create.mutate(
                { data: { label: label.trim() } },
                { onSuccess: () => setLabel("") },
              );
            }}
            disabled={create.isPending}
            data-testid="button-add-gt-result"
          >
            <Plus className="mr-2 h-4 w-4" /> Add
          </Button>
        </div>
        <Separator />
        {(results ?? []).length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            No result options configured.
          </p>
        ) : (
          <div className="divide-y">
            {(results ?? []).map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-3 py-2 text-sm"
                data-testid={`gt-result-row-${r.id}`}
              >
                <span className="flex-1">{r.label}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => del.mutate({ id: r.id })}
                  disabled={del.isPending}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GtRecipientsPanel() {
  const { data: s } = useGetSettings();
  const save = useSaveSettings();
  const [recipients, setRecipients] = useState<string[]>([]);
  const [next, setNext] = useState("");

  useEffect(() => {
    if (!s) return;
    setRecipients(s.gtInvestRecipients);
  }, [s]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>GT Invest notification recipients</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            type="email"
            placeholder="email@example.com"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            data-testid="input-gt-recipient"
          />
          <Button
            onClick={() => {
              if (!next) return;
              setRecipients((r) => Array.from(new Set([...r, next])));
              setNext("");
            }}
            data-testid="button-add-recipient"
          >
            <Plus className="mr-2 h-4 w-4" /> Add
          </Button>
        </div>
        <div className="space-y-1">
          {recipients.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              No recipients configured.
            </p>
          ) : (
            recipients.map((r) => (
              <div
                key={r}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                data-testid={`recipient-${r}`}
              >
                <span>{r}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    setRecipients((rs) => rs.filter((x) => x !== r))
                  }
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))
          )}
        </div>
        <div className="flex justify-end">
          <Button
            onClick={() =>
              save.mutate({
                data: { gtInvestRecipients: recipients },
              })
            }
            disabled={save.isPending}
            data-testid="button-save-recipients"
          >
            {save.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            <Save className="mr-2 h-4 w-4" /> Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
