import { useState } from "react";
import { ShieldCheck, Loader2, Plus, Trash2, Download } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  useGetCertInfo,
  useGenerateCsr,
  useImportCert,
  useImportCertWithKey,
} from "@/lib/api";

/**
 * HTTPS / TLS settings panel — embedded as a tab inside the Settings page.
 * Generate a CSR, send it to your internal CA, then import the signed
 * certificate. The private key never leaves the server.
 */
export function HttpsSettingsPanel() {
  const qc = useQueryClient();
  const { data: cert } = useGetCertInfo();
  const [commonName, setCommonName] = useState("");
  const [organization, setOrganization] = useState("");
  const [organizationalUnit, setOrganizationalUnit] = useState("");
  const [country, setCountry] = useState("");
  const [state, setState] = useState("");
  const [locality, setLocality] = useState("");
  const [sans, setSans] = useState<string[]>([]);
  const [nextSan, setNextSan] = useState("");
  const [csrPem, setCsrPem] = useState("");
  const [importPem, setImportPem] = useState("");
  const [importChain, setImportChain] = useState("");

  const csr = useGenerateCsr({
    mutation: {
      onSuccess: (res) => {
        setCsrPem(res.csrPem);
      },
    },
  });

  const importCert = useImportCert({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries();
        setImportPem("");
        setImportChain("");
      },
    },
  });

  const [importKeyPem, setImportKeyPem] = useState("");
  const [importKeyCertPem, setImportKeyCertPem] = useState("");
  const [importKeyChain, setImportKeyChain] = useState("");

  const importCertWithKey = useImportCertWithKey({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries();
        setImportKeyPem("");
        setImportKeyCertPem("");
        setImportKeyChain("");
      },
    },
  });

  function downloadCsr() {
    const blob = new Blob([csrPem], { type: "application/pkcs10" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${commonName || "request"}.csr`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-5 w-5 text-primary" /> Active certificate
          </CardTitle>
        </CardHeader>
        <CardContent>
          {cert?.present ? (
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <Field label="Subject" value={cert.subject} />
              <Field label="Issuer" value={cert.issuer} />
              <Field label="Valid from" value={cert.validFrom} />
              <Field label="Valid to" value={cert.validTo} />
              <Field
                label="Subject Alt Names"
                value={cert.sans?.join(", ") || "—"}
              />
              <Field label="Fingerprint" value={cert.fingerprint} />
            </dl>
          ) : (
            <Alert>
              <AlertDescription>
                No certificate currently installed. The server is using its
                bootstrap self-signed certificate.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1 — Generate a new CSR</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Common Name *</Label>
              <Input
                value={commonName}
                onChange={(e) => setCommonName(e.target.value)}
                placeholder="purchasing.lan"
                data-testid="input-cn"
              />
            </div>
            <div className="space-y-1">
              <Label>Organization</Label>
              <Input
                value={organization}
                onChange={(e) => setOrganization(e.target.value)}
                data-testid="input-o"
              />
            </div>
            <div className="space-y-1">
              <Label>Organizational Unit</Label>
              <Input
                value={organizationalUnit}
                onChange={(e) => setOrganizationalUnit(e.target.value)}
                data-testid="input-ou"
              />
            </div>
            <div className="space-y-1">
              <Label>Country (2 letters)</Label>
              <Input
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                maxLength={2}
                data-testid="input-c"
              />
            </div>
            <div className="space-y-1">
              <Label>State</Label>
              <Input
                value={state}
                onChange={(e) => setState(e.target.value)}
                data-testid="input-st"
              />
            </div>
            <div className="space-y-1">
              <Label>Locality</Label>
              <Input
                value={locality}
                onChange={(e) => setLocality(e.target.value)}
                data-testid="input-l"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Subject Alternative Names</Label>
            <div className="flex gap-2">
              <Input
                value={nextSan}
                onChange={(e) => setNextSan(e.target.value)}
                placeholder="alt.lan"
                data-testid="input-san"
              />
              <Button
                type="button"
                onClick={() => {
                  if (!nextSan) return;
                  setSans((s) => Array.from(new Set([...s, nextSan])));
                  setNextSan("");
                }}
                data-testid="button-add-san"
              >
                <Plus className="mr-2 h-4 w-4" /> Add
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {sans.map((s) => (
                <span
                  key={s}
                  className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs"
                  data-testid={`tag-san-${s}`}
                >
                  {s}
                  <button
                    type="button"
                    onClick={() => setSans((arr) => arr.filter((x) => x !== s))}
                    aria-label={`Remove ${s}`}
                  >
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </button>
                </span>
              ))}
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              onClick={() =>
                csr.mutate({
                  data: {
                    commonName,
                    organization: organization || null,
                    organizationalUnit: organizationalUnit || null,
                    country: country || null,
                    state: state || null,
                    locality: locality || null,
                    sans,
                  },
                })
              }
              disabled={!commonName || csr.isPending}
              data-testid="button-generate-csr"
            >
              {csr.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Generate CSR
            </Button>
          </div>

          {csrPem && (
            <>
              <Separator />
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Your CSR (PEM)</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={downloadCsr}
                    data-testid="button-download-csr"
                  >
                    <Download className="mr-2 h-4 w-4" /> Download
                  </Button>
                </div>
                <Textarea
                  rows={8}
                  className="font-mono text-xs"
                  readOnly
                  value={csrPem}
                  data-testid="textarea-csr"
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            2 — Import the signed certificate
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>Certificate (PEM)</Label>
            <Textarea
              rows={8}
              className="font-mono text-xs"
              value={importPem}
              onChange={(e) => setImportPem(e.target.value)}
              placeholder="-----BEGIN CERTIFICATE-----"
              data-testid="textarea-cert-pem"
            />
          </div>
          <div className="space-y-1">
            <Label>Chain / intermediates (optional)</Label>
            <Textarea
              rows={6}
              className="font-mono text-xs"
              value={importChain}
              onChange={(e) => setImportChain(e.target.value)}
              data-testid="textarea-chain-pem"
            />
          </div>
          <div className="flex justify-end">
            <Button
              onClick={() =>
                importCert.mutate({
                  data: {
                    certPem: importPem,
                    chainPem: importChain || null,
                  },
                })
              }
              disabled={!importPem || importCert.isPending}
              data-testid="button-import-cert"
            >
              {importCert.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Import certificate
            </Button>
          </div>
          <Alert>
            <AlertDescription>
              The CSR private key remains stored only on the server; it is
              never exposed via the API. Restart the API server after importing
              for HTTPS to use the new certificate.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            3 — Importer certificat + clé privée (sans CSR)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Utilisez cette section si vous disposez déjà du certificat et de la
            clé privée (ex. : certificat exporté depuis un autre serveur ou
            fourni par votre CA). Le serveur vérifie que la clé et le
            certificat correspondent avant de les enregistrer.
          </p>
          <div className="space-y-1">
            <Label>Certificat (PEM)</Label>
            <Textarea
              rows={8}
              className="font-mono text-xs"
              value={importKeyCertPem}
              onChange={(e) => setImportKeyCertPem(e.target.value)}
              placeholder="-----BEGIN CERTIFICATE-----"
              data-testid="textarea-cert-with-key-pem"
            />
          </div>
          <div className="space-y-1">
            <Label>Clé privée (PEM)</Label>
            <Textarea
              rows={8}
              className="font-mono text-xs"
              value={importKeyPem}
              onChange={(e) => setImportKeyPem(e.target.value)}
              placeholder="-----BEGIN PRIVATE KEY-----"
              data-testid="textarea-private-key-pem"
            />
          </div>
          <div className="space-y-1">
            <Label>Chaîne / intermédiaires (optionnel)</Label>
            <Textarea
              rows={4}
              className="font-mono text-xs"
              value={importKeyChain}
              onChange={(e) => setImportKeyChain(e.target.value)}
              data-testid="textarea-cert-with-key-chain"
            />
          </div>
          {importCertWithKey.isError && (
            <Alert variant="destructive">
              <AlertDescription>
                {String(
                  (importCertWithKey.error as { message?: string })?.message ??
                    "Erreur lors de l'import.",
                )}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end">
            <Button
              onClick={() =>
                importCertWithKey.mutate({
                  data: {
                    certPem: importKeyCertPem,
                    privateKeyPem: importKeyPem,
                    chainPem: importKeyChain || null,
                  },
                })
              }
              disabled={
                !importKeyCertPem || !importKeyPem || importCertWithKey.isPending
              }
              data-testid="button-import-cert-with-key"
            >
              {importCertWithKey.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Importer certificat + clé
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-xs">{value ?? "—"}</div>
    </div>
  );
}
