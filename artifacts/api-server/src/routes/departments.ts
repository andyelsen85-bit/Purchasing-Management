import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, departmentsTable } from "@workspace/db";
import {
  CreateDepartmentBody,
  UpdateDepartmentBody,
  UpdateDepartmentParams,
  DeleteDepartmentParams,
} from "@workspace/api-zod";
import { requireAuth, requireRole, getUser } from "../middlewares/auth";
import { audit } from "../lib/audit";

const router: IRouter = Router();

router.get("/departments", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(departmentsTable).orderBy(departmentsTable.name);
  res.json(rows);
});

router.post(
  "/departments",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const parsed = CreateDepartmentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [created] = await db
      .insert(departmentsTable)
      .values(parsed.data)
      .returning();
    await audit(getUser(req).id, "DEPARTMENT_CREATE", "department", created!.id);
    res.status(201).json(created);
  },
);

router.patch(
  "/departments/:id",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const params = UpdateDepartmentParams.safeParse(req.params);
    const body = UpdateDepartmentBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const [updated] = await db
      .update(departmentsTable)
      .set(body.data)
      .where(eq(departmentsTable.id, params.data.id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Department not found" });
      return;
    }
    await audit(getUser(req).id, "DEPARTMENT_UPDATE", "department", params.data.id);
    res.json(updated);
  },
);

router.delete(
  "/departments/:id",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const params = DeleteDepartmentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db.delete(departmentsTable).where(eq(departmentsTable.id, params.data.id));
    await audit(getUser(req).id, "DEPARTMENT_DELETE", "department", params.data.id);
    res.sendStatus(204);
  },
);

export default router;
