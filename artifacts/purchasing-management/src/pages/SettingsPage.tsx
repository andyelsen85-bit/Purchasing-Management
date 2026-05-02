import { useEffect, useState } from "react";
import { Save, Loader2, Image as ImageIcon, Trash2, Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useGetSettings, useUpdateSettings } from "@/lib/api";

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
          <TabsTrigger value="ldap" data-testid="tab-ldap">
            LDAP
          </TabsTrigger>
          <TabsTrigger value="smtp" data-testid="tab-smtp">
            SMTP
          </TabsTrigger>
          <TabsTrigger value="gt" data-testid="tab-gt">
            GT Invest
          </TabsTrigger>
        </TabsList>
        <TabsContent value="app">
          <AppSettingsPanel />
        </TabsContent>
        <TabsContent value="ldap">
          <LdapSettingsPanel />
        </TabsContent>
        <TabsContent value="smtp">
          <SmtpSettingsPanel />
        </TabsContent>
        <TabsContent value="gt">
          <GtRecipientsPanel />
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
  const [bindDn, setBindDn] = useState("");
  const [bindPassword, setBindPassword] = useState("");
  const [skipVerify, setSkipVerify] = useState(false);
  const [kerberos, setKerberos] = useState(false);
  const [spn, setSpn] = useState("");

  useEffect(() => {
    if (!s) return;
    setEnabled(s.ldap.enabled);
    setHost(s.ldap.host ?? "");
    setPort(s.ldap.port ?? 636);
    setBaseDn(s.ldap.baseDn ?? "");
    setBindDn(s.ldap.bindDn ?? "");
    setBindPassword("");
    setSkipVerify(s.ldap.skipVerify);
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
                    baseDn: baseDn || null,
                    bindDn: bindDn || null,
                    ...(bindPassword ? { bindPassword } : {}),
                    skipVerify,
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
