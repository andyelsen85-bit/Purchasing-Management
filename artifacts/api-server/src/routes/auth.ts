import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, userDepartmentsTable } from "@workspace/db";
import { LoginBody } from "@workspace/api-zod";
import { verifyPassword } from "../lib/auth";
import type { Role, SessionUser } from "../lib/auth";
import { ldapAuthenticate } from "../lib/ldap";
import { getSettings } from "../lib/settings";
import { audit } from "../lib/audit";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

async function buildSessionUser(userId: number): Promise<SessionUser | null> {
  const [u] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!u) return null;
  const depts = await db
    .select({ departmentId: userDepartmentsTable.departmentId })
    .from(userDepartmentsTable)
    .where(eq(userDepartmentsTable.userId, userId));
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email ?? null,
    roles: (u.roles as Role[]) ?? [],
    departmentIds: depts.map((d) => d.departmentId),
    source: u.source,
  };
}

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { username, password, useLdap } = parsed.data;

  let user: SessionUser | null = null;

  if (useLdap) {
    const settings = await getSettings();
    const result = await ldapAuthenticate(settings.ldap ?? {}, username, password);
    if (!result.ok) {
      await audit(null, "LOGIN_FAILED", "user", undefined, `LDAP: ${username}`, req.ip);
      res.status(401).json({ error: result.error ?? "Authentication failed" });
      return;
    }
    // Find or create user
    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.username, username));
    if (existing) {
      await db
        .update(usersTable)
        .set({
          source: "LDAP",
          displayName: result.displayName ?? existing.displayName,
          email: result.email ?? existing.email,
        })
        .where(eq(usersTable.id, existing.id));
      user = await buildSessionUser(existing.id);
    } else {
      const [created] = await db
        .insert(usersTable)
        .values({
          username,
          displayName: result.displayName ?? username,
          email: result.email ?? null,
          source: "LDAP",
          roles: ["DEPT_USER"],
        })
        .returning();
      user = created ? await buildSessionUser(created.id) : null;
    }
  } else {
    const [row] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.username, username));
    if (!row || !row.passwordHash) {
      await audit(null, "LOGIN_FAILED", "user", undefined, username, req.ip);
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const ok = await verifyPassword(password, row.passwordHash);
    if (!ok) {
      await audit(row.id, "LOGIN_FAILED", "user", row.id, username, req.ip);
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    user = await buildSessionUser(row.id);
  }

  if (!user) {
    res.status(500).json({ error: "Failed to load user" });
    return;
  }

  req.session.user = user;
  await audit(user.id, "LOGIN", "user", user.id, undefined, req.ip);
  res.json(user);
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const userId = req.session?.user?.id;
  await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
  if (userId) await audit(userId, "LOGOUT", "user", userId);
  res.json({ ok: true });
});

router.get("/auth/session", requireAuth, async (req, res): Promise<void> => {
  // Rebuild from DB so role changes are reflected
  const fresh = await buildSessionUser(req.session!.user!.id);
  if (!fresh) {
    res.status(401).json({ error: "User no longer exists" });
    return;
  }
  req.session.user = fresh;
  res.json({ user: fresh });
});

export default router;
