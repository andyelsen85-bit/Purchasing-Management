import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  gtInvestDatesTable,
  gtInvestResultsTable,
} from "@workspace/db";
import {
  UpdateSettingsBody,
  CreateGtInvestDateBody,
  CreateGtInvestResultBody,
  DeleteGtInvestDateParams,
  DeleteGtInvestResultParams,
} from "@workspace/api-zod";
import { requireAuth, requireRole, getUser } from "../middlewares/auth";
import { getSettings, toPublicSettings, updateSettingsRecord } from "../lib/settings";
import { audit } from "../lib/audit";

const router: IRouter = Router();

router.get("/settings", requireAuth, async (_req, res): Promise<void> => {
  const s = await getSettings();
  res.json(toPublicSettings(s));
});

router.patch(
  "/settings",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const parsed = UpdateSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const merged = await updateSettingsRecord(parsed.data as never);
    await audit(getUser(req).id, "SETTINGS_UPDATE", "settings");
    res.json(toPublicSettings(merged));
  },
);

router.get(
  "/settings/gt-invest-dates",
  requireAuth,
  async (_req, res): Promise<void> => {
    const rows = await db.select().from(gtInvestDatesTable).orderBy(gtInvestDatesTable.date);
    res.json(rows);
  },
);

router.post(
  "/settings/gt-invest-dates",
  requireAuth,
  requireRole("ADMIN", "FINANCIAL_ALL", "GT_INVEST"),
  async (req, res): Promise<void> => {
    const parsed = CreateGtInvestDateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [created] = await db
      .insert(gtInvestDatesTable)
      .values({
        date: new Date(parsed.data.date).toISOString().slice(0, 10),
        label: parsed.data.label ?? null,
      })
      .returning();
    await audit(getUser(req).id, "GT_DATE_CREATE", "gt-date", created!.id);
    res.status(201).json(created);
  },
);

router.delete(
  "/settings/gt-invest-dates/:id",
  requireAuth,
  requireRole("ADMIN", "FINANCIAL_ALL", "GT_INVEST"),
  async (req, res): Promise<void> => {
    const params = DeleteGtInvestDateParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db.delete(gtInvestDatesTable).where(eq(gtInvestDatesTable.id, params.data.id));
    await audit(getUser(req).id, "GT_DATE_DELETE", "gt-date", params.data.id);
    res.sendStatus(204);
  },
);

router.get(
  "/settings/gt-invest-results",
  requireAuth,
  async (_req, res): Promise<void> => {
    const rows = await db.select().from(gtInvestResultsTable).orderBy(gtInvestResultsTable.label);
    res.json(rows);
  },
);

router.post(
  "/settings/gt-invest-results",
  requireAuth,
  requireRole("ADMIN", "FINANCIAL_ALL", "GT_INVEST"),
  async (req, res): Promise<void> => {
    const parsed = CreateGtInvestResultBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [created] = await db
      .insert(gtInvestResultsTable)
      .values({ label: parsed.data.label })
      .returning();
    await audit(getUser(req).id, "GT_RESULT_CREATE", "gt-result", created!.id);
    res.status(201).json(created);
  },
);

router.delete(
  "/settings/gt-invest-results/:id",
  requireAuth,
  requireRole("ADMIN", "FINANCIAL_ALL", "GT_INVEST"),
  async (req, res): Promise<void> => {
    const params = DeleteGtInvestResultParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db.delete(gtInvestResultsTable).where(eq(gtInvestResultsTable.id, params.data.id));
    await audit(getUser(req).id, "GT_RESULT_DELETE", "gt-result", params.data.id);
    res.sendStatus(204);
  },
);

export default router;
