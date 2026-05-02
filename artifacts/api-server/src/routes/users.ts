import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  userDepartmentsTable,
  departmentsTable,
} from "@workspace/db";
import {
  CreateUserBody,
  UpdateUserBody,
  UpdateUserParams,
  DeleteUserParams,
} from "@workspace/api-zod";
import { hashPassword } from "../lib/auth";
import { requireAuth, requireRole, getUser } from "../middlewares/auth";
import { audit } from "../lib/audit";

const router: IRouter = Router();

async function loadUserWithDepts(id: number) {
  const [u] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!u) return null;
  const depts = await db
    .select({
      id: departmentsTable.id,
      name: departmentsTable.name,
      code: departmentsTable.code,
    })
    .from(userDepartmentsTable)
    .innerJoin(
      departmentsTable,
      eq(departmentsTable.id, userDepartmentsTable.departmentId),
    )
    .where(eq(userDepartmentsTable.userId, id));
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    source: u.source,
    roles: u.roles,
    departments: depts,
    createdAt: u.createdAt,
  };
}

router.get("/users", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(usersTable).orderBy(usersTable.username);
  const enriched = await Promise.all(rows.map((r) => loadUserWithDepts(r.id)));
  res.json(enriched.filter(Boolean));
});

router.post(
  "/users",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const parsed = CreateUserBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { username, displayName, email, password, roles, departmentIds } =
      parsed.data;
    const passwordHash = password ? await hashPassword(password) : null;
    const [created] = await db
      .insert(usersTable)
      .values({
        username,
        displayName,
        email: email ?? null,
        passwordHash,
        roles,
        source: "LOCAL",
      })
      .returning();
    if (departmentIds?.length && created) {
      await db
        .insert(userDepartmentsTable)
        .values(departmentIds.map((d) => ({ userId: created.id, departmentId: d })));
    }
    await audit(getUser(req).id, "USER_CREATE", "user", created!.id);
    res.status(201).json(await loadUserWithDepts(created!.id));
  },
);

router.patch(
  "/users/:id",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const params = UpdateUserParams.safeParse(req.params);
    const body = UpdateUserBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const { id } = params.data;
    const { displayName, email, password, roles, departmentIds } = body.data;
    const update: Record<string, unknown> = {};
    if (displayName != null) update.displayName = displayName;
    if (email !== undefined) update.email = email;
    if (roles) update.roles = roles;
    if (password) update.passwordHash = await hashPassword(password);
    if (Object.keys(update).length > 0) {
      await db.update(usersTable).set(update).where(eq(usersTable.id, id));
    }
    if (departmentIds) {
      await db
        .delete(userDepartmentsTable)
        .where(eq(userDepartmentsTable.userId, id));
      if (departmentIds.length > 0) {
        await db
          .insert(userDepartmentsTable)
          .values(
            departmentIds.map((d) => ({ userId: id, departmentId: d })),
          );
      }
    }
    await audit(getUser(req).id, "USER_UPDATE", "user", id);
    res.json(await loadUserWithDepts(id));
  },
);

router.delete(
  "/users/:id",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const params = DeleteUserParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db
      .delete(userDepartmentsTable)
      .where(eq(userDepartmentsTable.userId, params.data.id));
    await db.delete(usersTable).where(eq(usersTable.id, params.data.id));
    await audit(getUser(req).id, "USER_DELETE", "user", params.data.id);
    res.sendStatus(204);
  },
);

export default router;
