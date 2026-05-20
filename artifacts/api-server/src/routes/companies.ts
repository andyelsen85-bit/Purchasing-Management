import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, companiesTable, contactsTable } from "@workspace/db";
import {
  CreateCompanyBody,
  UpdateCompanyBody,
  UpdateCompanyParams,
  DeleteCompanyParams,
  GetCompanyParams,
  CreateContactParams,
  CreateContactBody,
  UpdateContactBody,
  UpdateContactParams,
  DeleteContactParams,
  ImportCompaniesBody,
} from "@workspace/api-zod";
import { requireAuth, getUser } from "../middlewares/auth";
import {
  canAddSupplier,
  canEditContact,
  canEditMasterData,
} from "../lib/permissions";
import { audit } from "../lib/audit";

const router: IRouter = Router();

/**
 * Full master-data guard (admin-only): edit company fields, delete
 * a company, delete a contact.
 */
function requireMasterDataEditor(req: Request, res: Response): boolean {
  if (!canEditMasterData(getUser(req))) {
    res.status(403).json({
      error: "Forbidden — only administrators may edit or delete master data",
    });
    return false;
  }
  return true;
}

/** Add a new supplier or contact. Open to all non-read-only users. */
function requireSupplierAdder(req: Request, res: Response): boolean {
  if (!canAddSupplier(getUser(req))) {
    res.status(403).json({
      error: "Forbidden — read-only users cannot add suppliers or contacts",
    });
    return false;
  }
  return true;
}

/** Edit an existing contact. Open to all non-read-only users. */
function requireContactEditor(req: Request, res: Response): boolean {
  if (!canEditContact(getUser(req))) {
    res.status(403).json({
      error: "Forbidden — read-only users cannot edit contacts",
    });
    return false;
  }
  return true;
}

router.get("/companies", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(companiesTable)
    .orderBy(companiesTable.name);
  res.json(rows);
});

/**
 * CSV export of every company and its contacts. One row per contact,
 * plus a single empty-contact row for companies that have none. The file
 * is UTF-8 with a BOM so Excel opens accented characters correctly, and
 * uses `;` as a separator (the locale Excel expects on French/Belgian/
 * Luxembourg machines, where the user base lives).
 */
router.get(
  "/companies/export.csv",
  requireAuth,
  async (_req, res): Promise<void> => {
    const companies = await db
      .select()
      .from(companiesTable)
      .orderBy(companiesTable.name);
    const contacts = await db.select().from(contactsTable);
    const byCompany = new Map<number, typeof contacts>();
    for (const c of contacts) {
      const list = byCompany.get(c.companyId) ?? [];
      list.push(c);
      byCompany.set(c.companyId, list);
    }
    const header = [
      "Company",
      "Address",
      "TaxID",
      "Notes",
      "ContactName",
      "ContactRole",
      "ContactEmail",
      "ContactPhone",
    ];
    const esc = (v: string | null | undefined): string => {
      const s = v ?? "";
      // Always quote — keeps things simple and survives semicolons, quotes
      // and newlines embedded in addresses or notes.
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines: string[] = [header.map((h) => esc(h)).join(";")];
    for (const c of companies) {
      const cs = byCompany.get(c.id) ?? [];
      if (cs.length === 0) {
        lines.push(
          [c.name, c.address, c.taxId, c.notes, "", "", "", ""]
            .map((v) => esc(v))
            .join(";"),
        );
      } else {
        for (const ct of cs) {
          lines.push(
            [
              c.name,
              c.address,
              c.taxId,
              c.notes,
              ct.name,
              ct.role,
              ct.email,
              ct.phone,
            ]
              .map((v) => esc(v))
              .join(";"),
          );
        }
      }
    }
    const csv = "\ufeff" + lines.join("\r\n") + "\r\n";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="companies.csv"',
    );
    res.send(csv);
  },
);

/**
 * Bulk import companies + contacts from CSV (parsed client-side, sent as
 * JSON rows). Companies match on case-insensitive name — existing ones
 * are reused, missing ones are created with the row's address / taxId /
 * notes. Contacts are appended; duplicates within the same company are
 * skipped (matched by email when present, otherwise by name).
 */
router.post(
  "/companies/import",
  requireAuth,
  async (req, res): Promise<void> => {
    if (!requireSupplierAdder(req, res)) return;
    const parsed = ImportCompaniesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const existing = await db.select().from(companiesTable);
    const byName = new Map<string, (typeof existing)[number]>();
    for (const c of existing) byName.set(c.name.trim().toLowerCase(), c);

    // Preload every contact once and group by company so each import row
    // can dedupe in O(1) without hitting the DB per row.
    const allContacts = await db.select().from(contactsTable);
    const contactsByCompany = new Map<
      number,
      Array<{ email: string; name: string }>
    >();
    for (const c of allContacts) {
      const list = contactsByCompany.get(c.companyId) ?? [];
      list.push({
        email: (c.email ?? "").trim().toLowerCase(),
        name: c.name.trim().toLowerCase(),
      });
      contactsByCompany.set(c.companyId, list);
    }

    let companiesCreated = 0;
    let companiesMatched = 0;
    let contactsCreated = 0;
    let contactsSkipped = 0;
    const errors: Array<{ row: number; message: string }> = [];

    for (let i = 0; i < parsed.data.rows.length; i++) {
      const r = parsed.data.rows[i]!;
      const name = (r.name ?? "").trim();
      if (!name) {
        errors.push({ row: i + 1, message: "Nom de société manquant" });
        continue;
      }
      try {
        const key = name.toLowerCase();
        let company = byName.get(key);
        if (!company) {
          const [created] = await db
            .insert(companiesTable)
            .values({
              name,
              address: r.address ?? null,
              taxId: r.taxId ?? null,
              notes: r.notes ?? null,
            })
            .returning();
          company = created!;
          byName.set(key, company);
          companiesCreated += 1;
          await audit(getUser(req).id, "COMPANY_CREATE", "company", company.id);
        } else {
          companiesMatched += 1;
        }

        const ctName = (r.contactName ?? "").trim();
        const ctEmail = (r.contactEmail ?? "").trim();
        if (!ctName && !ctEmail) continue;

        const existingContacts = contactsByCompany.get(company.id) ?? [];
        const ctEmailLc = ctEmail.toLowerCase();
        const ctNameLc = ctName.toLowerCase();
        const dup = existingContacts.find((c) =>
          ctEmail ? c.email === ctEmailLc : c.name === ctNameLc,
        );
        if (dup) {
          contactsSkipped += 1;
          continue;
        }
        const [created] = await db
          .insert(contactsTable)
          .values({
            companyId: company.id,
            name: ctName || ctEmail,
            email: ctEmail || null,
            phone: (r.contactPhone ?? "").trim() || null,
            role: (r.contactRole ?? "").trim() || null,
          })
          .returning();
        contactsCreated += 1;
        existingContacts.push({ email: ctEmailLc, name: ctNameLc });
        contactsByCompany.set(company.id, existingContacts);
        await audit(getUser(req).id, "CONTACT_CREATE", "contact", created!.id);
      } catch (err) {
        errors.push({
          row: i + 1,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    res.json({
      companiesCreated,
      companiesMatched,
      contactsCreated,
      contactsSkipped,
      errors,
    });
  },
);

router.post("/companies", requireAuth, async (req, res): Promise<void> => {
  if (!requireSupplierAdder(req, res)) return;
  const parsed = CreateCompanyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [created] = await db
    .insert(companiesTable)
    .values(parsed.data)
    .returning();
  await audit(getUser(req).id, "COMPANY_CREATE", "company", created!.id);
  res.status(201).json(created);
});

router.get("/companies/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetCompanyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [c] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, params.data.id));
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const contacts = await db
    .select()
    .from(contactsTable)
    .where(eq(contactsTable.companyId, c.id));
  res.json({ ...c, contacts });
});

router.patch(
  "/companies/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    if (!requireMasterDataEditor(req, res)) return;
    const params = UpdateCompanyParams.safeParse(req.params);
    const body = UpdateCompanyBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const [updated] = await db
      .update(companiesTable)
      .set(body.data)
      .where(eq(companiesTable.id, params.data.id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await audit(getUser(req).id, "COMPANY_UPDATE", "company", params.data.id);
    res.json(updated);
  },
);

router.delete(
  "/companies/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    if (!requireMasterDataEditor(req, res)) return;
    const params = DeleteCompanyParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db
      .delete(contactsTable)
      .where(eq(contactsTable.companyId, params.data.id));
    await db
      .delete(companiesTable)
      .where(eq(companiesTable.id, params.data.id));
    await audit(getUser(req).id, "COMPANY_DELETE", "company", params.data.id);
    res.sendStatus(204);
  },
);

// Contacts
router.post(
  "/companies/:id/contacts",
  requireAuth,
  async (req, res): Promise<void> => {
    if (!requireSupplierAdder(req, res)) return;
    const params = CreateContactParams.safeParse(req.params);
    const body = CreateContactBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const [created] = await db
      .insert(contactsTable)
      .values({ ...body.data, companyId: params.data.id })
      .returning();
    await audit(getUser(req).id, "CONTACT_CREATE", "contact", created!.id);
    res.status(201).json(created);
  },
);

router.patch(
  "/contacts/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    if (!requireContactEditor(req, res)) return;
    const params = UpdateContactParams.safeParse(req.params);
    const body = UpdateContactBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const [updated] = await db
      .update(contactsTable)
      .set(body.data)
      .where(eq(contactsTable.id, params.data.id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await audit(getUser(req).id, "CONTACT_UPDATE", "contact", params.data.id);
    res.json(updated);
  },
);

router.delete(
  "/contacts/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    if (!requireMasterDataEditor(req, res)) return;
    const params = DeleteContactParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db
      .delete(contactsTable)
      .where(eq(contactsTable.id, params.data.id));
    await audit(getUser(req).id, "CONTACT_DELETE", "contact", params.data.id);
    res.sendStatus(204);
  },
);

export default router;
