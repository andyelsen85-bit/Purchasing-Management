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
