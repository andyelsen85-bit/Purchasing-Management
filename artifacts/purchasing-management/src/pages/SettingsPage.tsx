import { useEffect, useState } from "react";
import { Save, Loader2, Image as ImageIcon, Trash2, Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
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
} from "@/lib/api";

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
        <TabsContent value="departments">
          <DepartmentsPanel />
        </TabsContent>
        <TabsContent value="ldap">
          <div className="space-y-4">
            <LdapSettingsPanel />
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
  const [caCert, setCaCert] = useState("");
  const [caCertSet, setCaCertSet] = useState(false);
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

function GroupMappingPanel() {
  const { data: s } = useGetSettings();
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>AD group mapping</CardTitle>
        <p className="text-xs text-muted-foreground">
          Map LDAP / Kerberos group names (substring or CN) to app roles
          and department codes. Applied on every sign-in.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label className="text-sm font-medium">Group → Role</Label>
          <div className="grid grid-cols-[1fr_180px_auto] gap-2">
            <Input
              placeholder="Group key (e.g. PurchasingAdmins)"
              value={rk}
              onChange={(e) => setRk(e.target.value)}
              data-testid="input-grm-key"
            />
            <Input
              placeholder="ADMIN | FINANCIAL_ALL | …"
              value={rv}
              onChange={(e) => setRv(e.target.value)}
              data-testid="input-grm-val"
            />
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
            {Object.entries(roleMap).map(([k, v]) => (
              <div
                key={k}
                className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm"
              >
                <span>
                  <code className="text-xs">{k}</code> → <strong>{v}</strong>
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
            ))}
          </div>
        </div>
        <Separator />
        <div className="space-y-2">
          <Label className="text-sm font-medium">Group → Department code</Label>
          <div className="grid grid-cols-[1fr_180px_auto] gap-2">
            <Input
              placeholder="Group key"
              value={dk}
              onChange={(e) => setDk(e.target.value)}
              data-testid="input-gdm-key"
            />
            <Input
              placeholder="Department code"
              value={dv}
              onChange={(e) => setDv(e.target.value)}
              data-testid="input-gdm-val"
            />
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
            {Object.entries(deptMap).map(([k, v]) => (
              <div
                key={k}
                className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm"
              >
                <span>
                  <code className="text-xs">{k}</code> → <strong>{v}</strong>
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
            ))}
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
            disabled={create.isPending}
            data-testid="button-add-gt-date"
          >
            <Plus className="mr-2 h-4 w-4" /> Add
          </Button>
        </div>
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
