import { useRef, useState } from "react";
import {
  Plus,
  Building2,
  Loader2,
  Mail,
  Phone,
  Trash2,
  Pencil,
  Save,
  X,
  Download,
  Upload,
  FileSpreadsheet,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  useListCompanies,
  useCreateCompany,
  useGetCompany,
  useUpdateCompany,
  useCreateContact,
  useUpdateContact,
  useDeleteContact,
  useDeleteCompany,
  useGetSession,
  useImportCompanies,
  type Company,
  type Contact,
  type ImportCompanyRow,
  type ImportCompaniesResult,
} from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

/**
 * Permission helpers — mirror the server-side rules in
 * `artifacts/api-server/src/lib/permissions.ts` so we don't show
 * buttons that would just 403 when clicked.
 *
 * - canEditMasterData (ADMIN, FINANCIAL_ALL): full control — edit
 *   company fields, delete companies, delete contacts.
 * - canAddSupplier (everyone except read-only roles): may add
 *   suppliers, add contacts, and edit contacts. Department users
 *   onboard their own suppliers and keep contact info up to date.
 */
// Roles allowed to *view* the Companies page. Per the session plan
// decision, every Financial role (All / Invoice / Payment) joins ADMIN
// here — they all consult the supplier directory while doing their
// step. Department users and read-only roles do not see the page in
// the nav and get a 403-style placeholder if they navigate to it
// directly.
const FINANCIAL_ROLES = [
  "ADMIN",
  "FINANCIAL_ALL",
  "FINANCIAL_INVOICE",
  "FINANCIAL_PAYMENT",
] as const;

function useCanEditMasterData(): boolean {
  const { data: session } = useGetSession();
  const roles = session?.user?.roles ?? [];
  return roles.includes("ADMIN") || roles.includes("FINANCIAL_ALL");
}

function useCanAddSupplier(): boolean {
  const { data: session } = useGetSession();
  const roles = session?.user?.roles ?? [];
  // Adding a supplier is restricted to the same roles that can see
  // the page — every Financial role plus ADMIN.
  return FINANCIAL_ROLES.some((r) => roles.includes(r));
}

export function CompaniesPage() {
  const { data: session } = useGetSession();
  const { data: companies } = useListCompanies();
  const [selected, setSelected] = useState<Company | null>(null);
  const canAdd = useCanAddSupplier();

  const roles = session?.user?.roles ?? [];
  const canViewPage = FINANCIAL_ROLES.some((r) => roles.includes(r));

  if (session && !canViewPage) {
    return (
      <div className="p-12 text-center text-sm text-muted-foreground">
        Vous n'avez pas les autorisations nécessaires pour accéder à cette page.
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-page-title">
            Companies
          </h1>
          <p className="text-sm text-muted-foreground">
            Suppliers and their contacts
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canAdd && <ImportExportButtons />}
          {canAdd && <NewCompanyDialog />}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-sm">All companies</CardTitle>
          </CardHeader>
          <CardContent className="p-2">
            {(companies ?? []).length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                No companies yet.
              </p>
            ) : (
              <div className="space-y-1">
                {(companies ?? []).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSelected(c)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover-elevate ${
                      selected?.id === c.id ? "bg-secondary" : ""
                    }`}
                    data-testid={`button-company-${c.id}`}
                  >
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate">{c.name}</span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="lg:col-span-2">
          {selected ? (
            <CompanyDetailCard companyId={selected.id} key={selected.id} />
          ) : (
            <Card>
              <CardContent className="p-12 text-center text-sm text-muted-foreground">
                Select a company to view its contacts
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * CSV import/export controls for the supplier directory.
 *
 * - Export downloads the current list as a UTF-8 CSV (`;` separator, BOM)
 *   suitable for direct opening in Excel — one row per contact.
 * - Template downloads an empty CSV with just the header row, so users
 *   know the column order to fill in.
 * - Import accepts a CSV file (either `;` or `,` separated), parses it
 *   in the browser, and POSTs the rows to /api/companies/import which
 *   upserts companies by name and appends new contacts.
 */
function ImportExportButtons() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ImportCompaniesResult | null>(null);
  const importMut = useImportCompanies({
    mutation: {
      onSuccess: (data) => {
        setResult(data);
        qc.invalidateQueries();
        toast({
          title: "Import terminé",
          description: `${data.companiesCreated} société(s) créée(s), ${data.contactsCreated} contact(s) ajouté(s).`,
        });
      },
      onError: (err: unknown) => {
        toast({
          title: "Échec de l'import",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  async function downloadExport() {
    const res = await fetch("/api/companies/export.csv", {
      credentials: "include",
    });
    if (!res.ok) {
      toast({
        title: "Échec de l'export",
        description: `HTTP ${res.status}`,
        variant: "destructive",
      });
      return;
    }
    const blob = await res.blob();
    triggerDownload(blob, "companies.csv");
  }

  function downloadTemplate() {
    const header =
      "Company;Address;TaxID;Notes;ContactName;ContactRole;ContactEmail;ContactPhone";
    const example =
      '"Acme SA";"1 rue Exemple, L-1234 Luxembourg";"LU12345678";"";"Jean Dupont";"Sales";"jean@acme.lu";"+352 12 34 56"';
    const csv = "\ufeff" + header + "\r\n" + example + "\r\n";
    triggerDownload(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      "companies-template.csv",
    );
  }

  function pickFile() {
    setResult(null);
    fileRef.current?.click();
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const text = await f.text();
      const rows = parseCompaniesCsv(text);
      if (rows.length === 0) {
        toast({
          title: "Fichier vide",
          description: "Aucune ligne de société trouvée dans le CSV.",
          variant: "destructive",
        });
        return;
      }
      importMut.mutate({ data: { rows } });
    } catch (err) {
      toast({
        title: "CSV illisible",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={onFileChosen}
        data-testid="input-import-companies"
      />
      <Button
        variant="outline"
        size="sm"
        onClick={downloadTemplate}
        data-testid="button-template-companies"
      >
        <FileSpreadsheet className="mr-2 h-4 w-4" /> Modèle CSV
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={downloadExport}
        data-testid="button-export-companies"
      >
        <Download className="mr-2 h-4 w-4" /> Exporter
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={pickFile}
        disabled={importMut.isPending}
        data-testid="button-import-companies"
      >
        {importMut.isPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Upload className="mr-2 h-4 w-4" />
        )}
        Importer
      </Button>
      <Dialog
        open={result !== null}
        onOpenChange={(o) => !o && setResult(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Résultat de l'import</DialogTitle>
          </DialogHeader>
          {result && (
            <div className="space-y-2 text-sm">
              <div>
                <strong>{result.companiesCreated}</strong> nouvelle(s)
                société(s) créée(s).
              </div>
              <div>
                <strong>{result.companiesMatched}</strong> société(s) déjà
                existante(s) (réutilisées).
              </div>
              <div>
                <strong>{result.contactsCreated}</strong> contact(s) ajouté(s).
              </div>
              <div>
                <strong>{result.contactsSkipped}</strong> contact(s) ignoré(s)
                (doublon).
              </div>
              {result.errors.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1 font-medium text-destructive">
                    {result.errors.length} erreur(s) :
                  </div>
                  <ul className="max-h-40 overflow-auto rounded bg-muted/30 p-2 text-xs">
                    {result.errors.map((e, i) => (
                      <li key={i}>
                        Ligne {e.row} : {e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setResult(null)}>Fermer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Minimal RFC4180-ish CSV parser. Auto-detects `;` vs `,` separator
 * from the header line (Excel exports use `;` on French/Belgian/Luxembourg
 * locales). Handles quoted fields with embedded separators, quotes
 * (escaped as `""`) and newlines. Headers are matched case-insensitively
 * against the known column names — order doesn't matter, missing columns
 * become null.
 */
function parseCompaniesCsv(text: string): ImportCompanyRow[] {
  // Strip BOM
  let src = text.replace(/^\ufeff/, "");
  // Detect separator from the first line (count outside quotes).
  const firstLineEnd = src.search(/\r?\n/);
  const firstLine = firstLineEnd === -1 ? src : src.slice(0, firstLineEnd);
  const sep = (firstLine.match(/;/g) ?? []).length >=
    (firstLine.match(/,/g) ?? []).length
    ? ";"
    : ",";

  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.length > 0)) records.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.length > 0)) records.push(row);
  }

  if (records.length === 0) return [];
  const headers = records[0]!.map((h) => h.trim().toLowerCase());
  const idx = (name: string) => headers.indexOf(name.toLowerCase());
  const iName = idx("company");
  const iAddr = idx("address");
  const iTax = idx("taxid");
  const iNotes = idx("notes");
  const iCName = idx("contactname");
  const iCRole = idx("contactrole");
  const iCEmail = idx("contactemail");
  const iCPhone = idx("contactphone");
  if (iName === -1) {
    throw new Error(
      "Colonne « Company » introuvable. Téléchargez le modèle CSV pour le format attendu.",
    );
  }

  const pick = (cells: string[], i: number): string | null => {
    if (i === -1) return null;
    const v = (cells[i] ?? "").trim();
    return v.length === 0 ? null : v;
  };

  const out: ImportCompanyRow[] = [];
  for (let r = 1; r < records.length; r++) {
    const cells = records[r]!;
    const name = (cells[iName] ?? "").trim();
    if (!name) continue;
    out.push({
      name,
      address: pick(cells, iAddr),
      taxId: pick(cells, iTax),
      notes: pick(cells, iNotes),
      contactName: pick(cells, iCName),
      contactRole: pick(cells, iCRole),
      contactEmail: pick(cells, iCEmail),
      contactPhone: pick(cells, iCPhone),
    });
  }
  return out;
}

function NewCompanyDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [taxId, setTaxId] = useState("");
  const [notes, setNotes] = useState("");
  const create = useCreateCompany({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries();
        setOpen(false);
        setName("");
        setAddress("");
        setTaxId("");
        setNotes("");
      },
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="button-new-company">
          <Plus className="mr-2 h-4 w-4" /> New company
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New company</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Name *</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="input-company-name"
            />
          </div>
          <div>
            <Label>Address</Label>
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              data-testid="input-company-address"
            />
          </div>
          <div>
            <Label>Tax ID</Label>
            <Input
              value={taxId}
              onChange={(e) => setTaxId(e.target.value)}
              data-testid="input-company-taxid"
            />
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="input-company-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() =>
              create.mutate({
                data: {
                  name,
                  address: address || null,
                  taxId: taxId || null,
                  notes: notes || null,
                },
              })
            }
            disabled={!name || create.isPending}
            data-testid="button-save-company"
          >
            {create.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CompanyDetailCard({ companyId }: { companyId: number }) {
  const qc = useQueryClient();
  const { data: company } = useGetCompany(companyId);
  const canEdit = useCanEditMasterData();
  const canAdd = useCanAddSupplier();

  const [editingCompany, setEditingCompany] = useState(false);
  const [editName, setEditName] = useState("");
  const [editAddress, setEditAddress] = useState("");
  const [editTaxId, setEditTaxId] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const updateCompany = useUpdateCompany({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries();
        setEditingCompany(false);
      },
    },
  });
  const delCompany = useDeleteCompany({
    mutation: { onSuccess: () => qc.invalidateQueries() },
  });
  const createContact = useCreateContact({
    mutation: { onSuccess: () => qc.invalidateQueries() },
  });
  const delContact = useDeleteContact({
    mutation: { onSuccess: () => qc.invalidateQueries() },
  });

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState("");

  if (!company) return null;

  function startEditCompany() {
    setEditName(company!.name);
    setEditAddress(company!.address ?? "");
    setEditTaxId(company!.taxId ?? "");
    setEditNotes(company!.notes ?? "");
    setEditingCompany(true);
  }

  function cancelEditCompany() {
    setEditingCompany(false);
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between">
        {editingCompany ? (
          <div className="flex-1 space-y-2 pr-2">
            <div>
              <Label className="text-xs">Nom *</Label>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                data-testid="input-edit-company-name"
              />
            </div>
            <div>
              <Label className="text-xs">Adresse</Label>
              <Input
                value={editAddress}
                onChange={(e) => setEditAddress(e.target.value)}
                data-testid="input-edit-company-address"
              />
            </div>
            <div>
              <Label className="text-xs">N° TVA / SIRET</Label>
              <Input
                value={editTaxId}
                onChange={(e) => setEditTaxId(e.target.value)}
                data-testid="input-edit-company-taxid"
              />
            </div>
            <div>
              <Label className="text-xs">Notes</Label>
              <Textarea
                rows={2}
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                data-testid="input-edit-company-notes"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={cancelEditCompany}
                data-testid="button-cancel-edit-company"
              >
                <X className="mr-2 h-4 w-4" /> Annuler
              </Button>
              <Button
                size="sm"
                disabled={!editName.trim() || updateCompany.isPending}
                onClick={() =>
                  updateCompany.mutate({
                    id: company.id,
                    data: {
                      name: editName,
                      address: editAddress || null,
                      taxId: editTaxId || null,
                      notes: editNotes || null,
                    },
                  })
                }
                data-testid="button-save-company-details"
              >
                {updateCompany.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Enregistrer
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex-1">
            <CardTitle data-testid="text-company-name">{company.name}</CardTitle>
            {company.address && (
              <div className="mt-1 text-sm text-muted-foreground">{company.address}</div>
            )}
            {company.taxId && (
              <div className="mt-0.5 text-xs text-muted-foreground">TVA / SIRET : {company.taxId}</div>
            )}
            {company.notes && (
              <div className="mt-1 text-xs italic text-muted-foreground">{company.notes}</div>
            )}
          </div>
        )}
        {!editingCompany && (
          <div className="flex items-center gap-1">
            {canEdit && (
              <Button
                variant="ghost"
                size="icon"
                onClick={startEditCompany}
                data-testid="button-edit-company"
              >
                <Pencil className="h-4 w-4" />
              </Button>
            )}
            {canEdit && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (confirm(`Supprimer la société "${company.name}" ?`)) {
                    delCompany.mutate({ id: company.id });
                  }
                }}
                data-testid="button-delete-company"
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <h3 className="mb-2 text-sm font-medium">Contacts</h3>
          {(company.contacts ?? []).length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              No contacts yet.
            </p>
          ) : (
            <div className="divide-y">
              {(company.contacts ?? []).map((c) => (
                <ContactRow
                  key={c.id}
                  contact={c}
                  canEditContact={canAdd}
                  canDeleteContact={canEdit}
                  onDelete={() => delContact.mutate({ id: c.id })}
                />
              ))}
            </div>
          )}
        </div>
        {canAdd && <Separator />}
        {canAdd && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <h3 className="text-sm font-medium">Add contact</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input
              placeholder="Name *"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="input-contact-name"
            />
            <Input
              placeholder="Role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              data-testid="input-contact-role"
            />
            <Input
              placeholder="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="input-contact-email"
            />
            <Input
              placeholder="Phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              data-testid="input-contact-phone"
            />
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => {
                if (!name.trim()) return;
                createContact.mutate(
                  {
                    id: company.id,
                    data: {
                      name,
                      email: email || null,
                      phone: phone || null,
                      role: role || null,
                    },
                  },
                  {
                    onSuccess: () => {
                      setName("");
                      setEmail("");
                      setPhone("");
                      setRole("");
                    },
                  },
                );
              }}
              disabled={!name || createContact.isPending}
              data-testid="button-add-contact"
            >
              <Plus className="mr-2 h-4 w-4" /> Add
            </Button>
          </div>
        </div>
        )}
      </CardContent>
    </Card>
  );
}

function ContactRow({
  contact,
  canEditContact,
  canDeleteContact,
  onDelete,
}: {
  contact: Contact;
  canEditContact: boolean;
  canDeleteContact: boolean;
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(contact.name);
  const [role, setRole] = useState(contact.role ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [phone, setPhone] = useState(contact.phone ?? "");
  const update = useUpdateContact({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries();
        setEditing(false);
      },
    },
  });

  if (editing) {
    return (
      <div
        className="space-y-2 py-2"
        data-testid={`contact-${contact.id}-edit`}
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name *"
            data-testid={`input-edit-contact-name-${contact.id}`}
          />
          <Input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Role"
            data-testid={`input-edit-contact-role-${contact.id}`}
          />
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            data-testid={`input-edit-contact-email-${contact.id}`}
          />
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone"
            data-testid={`input-edit-contact-phone-${contact.id}`}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setName(contact.name);
              setRole(contact.role ?? "");
              setEmail(contact.email ?? "");
              setPhone(contact.phone ?? "");
              setEditing(false);
            }}
            data-testid={`button-cancel-edit-contact-${contact.id}`}
          >
            <X className="mr-2 h-4 w-4" /> Cancel
          </Button>
          <Button
            size="sm"
            disabled={!name.trim() || update.isPending}
            onClick={() =>
              update.mutate({
                id: contact.id,
                data: {
                  name,
                  role: role || null,
                  email: email || null,
                  phone: phone || null,
                },
              })
            }
            data-testid={`button-save-contact-${contact.id}`}
          >
            {update.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex items-start justify-between py-2"
      data-testid={`contact-${contact.id}`}
    >
      <div>
        <div className="text-sm font-medium">{contact.name}</div>
        <div className="text-xs text-muted-foreground">{contact.role}</div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
          {contact.email && (
            <a
              href={`mailto:${contact.email}`}
              className="flex items-center gap-1 text-primary hover:underline"
            >
              <Mail className="h-3 w-3" /> {contact.email}
            </a>
          )}
          {contact.phone && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Phone className="h-3 w-3" /> {contact.phone}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1">
        {canEditContact && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setEditing(true)}
            data-testid={`button-edit-contact-${contact.id}`}
          >
            <Pencil className="h-4 w-4" />
          </Button>
        )}
        {canDeleteContact && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onDelete}
            data-testid={`button-del-contact-${contact.id}`}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        )}
      </div>
    </div>
  );
}
