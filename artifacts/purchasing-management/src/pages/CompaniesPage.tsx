import { useState } from "react";
import { Plus, Building2, Loader2, Mail, Phone, Trash2 } from "lucide-react";
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
  useCreateContact,
  useDeleteContact,
  useDeleteCompany,
  useGetSession,
  type Company,
} from "@/lib/api";

/**
 * Master-data editing (create/edit/delete companies and contacts) is
 * restricted server-side to ADMIN and FINANCIAL_ALL via
 * `canEditMasterData` in `artifacts/api-server/src/lib/permissions.ts`.
 * Mirror that here so read-only roles don't see buttons that just
 * 403 when clicked.
 */
function useCanEditMasterData(): boolean {
  const { data: session } = useGetSession();
  const roles = session?.user?.roles ?? [];
  return roles.includes("ADMIN") || roles.includes("FINANCIAL_ALL");
}

export function CompaniesPage() {
  const { data: companies } = useListCompanies();
  const [selected, setSelected] = useState<Company | null>(null);
  const canEdit = useCanEditMasterData();

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
        {canEdit && <NewCompanyDialog />}
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

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between">
        <div>
          <CardTitle data-testid="text-company-name">{company.name}</CardTitle>
          <div className="mt-1 text-sm text-muted-foreground">
            {company.address}
          </div>
        </div>
        {canEdit && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              if (confirm(`Delete company "${company.name}"?`)) {
                delCompany.mutate({ id: company.id });
              }
            }}
            data-testid="button-delete-company"
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
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
                <div
                  key={c.id}
                  className="flex items-start justify-between py-2"
                  data-testid={`contact-${c.id}`}
                >
                  <div>
                    <div className="text-sm font-medium">{c.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.role}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                      {c.email && (
                        <a
                          href={`mailto:${c.email}`}
                          className="flex items-center gap-1 text-primary hover:underline"
                        >
                          <Mail className="h-3 w-3" /> {c.email}
                        </a>
                      )}
                      {c.phone && (
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <Phone className="h-3 w-3" /> {c.phone}
                        </span>
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => delContact.mutate({ id: c.id })}
                      data-testid={`button-del-contact-${c.id}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {canEdit && <Separator />}
        {canEdit && (
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
