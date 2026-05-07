import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, userDepartmentsTable } from "@workspace/db";
import { LoginBody } from "@workspace/api-zod";
import { verifyPassword, hashPassword } from "../lib/auth";
import type { Role, SessionUser } from "../lib/auth";
import { sql } from "drizzle-orm";
import { ldapAuthenticate, lookupLdapGroups } from "../lib/ldap";
import { getSettings } from "../lib/settings";
import { audit } from "../lib/audit";
import { requireAuth } from "../middlewares/auth";
import {
  mapGroupsToRoles,
  mapGroupsToDepartmentIds,
  syncUserDepartments,
  hasMapping,
} from "../lib/groupMapping";

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
    // Re-derive roles + departments from AD groups every sign-in so the
    // directory remains authoritative — removing a user from a mapped AD
    // group must revoke the corresponding role/department. The mapping is
    // only authoritative when the operator has actually configured it; if
    // groupRoleMap/groupDepartmentMap are empty we fall back to existing
    // values (or DEPT_USER for brand-new users) and leave department
    // memberships alone so manual assignments survive.
    const groups = result.groups ?? [];
    const roleMap = settings.ldap?.groupRoleMap;
    const deptMap = settings.ldap?.groupDepartmentMap;
    const useRoleMap = hasMapping(roleMap);
    const useDeptMap = hasMapping(deptMap);
    const derivedRoles = useRoleMap ? mapGroupsToRoles(groups, roleMap) : null;
    // When role mapping is configured, a user with no matching group has no
    // authorised role and must not be allowed in.
    if (useRoleMap && derivedRoles !== null && derivedRoles.length === 0) {
      await audit(null, "LOGIN_FAILED", "user", undefined, `LDAP: ${username}`, req.ip);
      res.status(401).json({ error: "Aucun groupe AD ne correspond à un rôle autorisé" });
      return;
    }
    const derivedDeptIds = useDeptMap
      ? await mapGroupsToDepartmentIds(groups, deptMap)
      : null;
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
          ...(derivedRoles ? { roles: derivedRoles } : {}),
        })
        .where(eq(usersTable.id, existing.id));
      if (derivedDeptIds !== null)
        await syncUserDepartments(existing.id, derivedDeptIds);
      user = await buildSessionUser(existing.id);
    } else {
      const [created] = await db
        .insert(usersTable)
        .values({
          username,
          displayName: result.displayName ?? username,
          email: result.email ?? null,
          source: "LDAP",
          roles: derivedRoles ?? ["DEPT_USER"],
        })
        .returning();
      if (created && derivedDeptIds !== null)
        await syncUserDepartments(created.id, derivedDeptIds);
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

/**
 * Kerberos / SPNEGO negotiate endpoint.
 *
 * On a domain-joined Windows host the browser will automatically attach an
 * `Authorization: Negotiate <base64-spnego>` header. When that header is
 * present we forward the token to the configured Kerberos backend (set up
 * via lib/auth.ts; in this environment the keytab is not provisioned, so
 * the call returns 501 with a clear hint).
 *
 * When the header is missing we reply with `401 WWW-Authenticate: Negotiate`,
 * which is the standard handshake that triggers the browser to retry with
 * its Kerberos ticket.
 */
router.get("/auth/negotiate", async (req, res): Promise<void> => {
  // Load settings first so we know whether to even issue the SPNEGO challenge.
  // Sending WWW-Authenticate: Negotiate when Kerberos isn't configured causes
  // the browser to attempt a full ticket exchange and potentially show an auth
  // dialog — we must short-circuit before that happens.
  const settings = await getSettings();
  const spn =
    process.env.KRB5_SPN ?? settings.ldap?.servicePrincipalName ?? "";
  const hasKeytab = Boolean(process.env.KRB5_KEYTAB);
  const kerberosReady =
    !!settings.ldap?.kerberosEnabled && !!spn && hasKeytab;

  const header = req.headers["authorization"];
  const hasToken = !!header && /^Negotiate\s+/i.test(header);

  if (!hasToken) {
    if (!kerberosReady) {
      // Kerberos not configured — signal the client to fall through to the
      // form without triggering a browser SPNEGO exchange.
      res.status(401).json({ error: "Kerberos not configured on this server" });
      return;
    }
    // Issue the SPNEGO challenge; browser will retry with a Kerberos ticket.
    res.setHeader("WWW-Authenticate", "Negotiate");
    res.status(401).json({ error: "Negotiate required" });
    return;
  }

  if (!kerberosReady) {
    res.status(501).json({
      error:
        "Kerberos backend not configured on this server. Set KRB5_KEYTAB and configure the SPN in Settings → LDAP, ou utilisez le formulaire de connexion LDAP/local.",
    });
    return;
  }

  // Try to dynamically load the optional `kerberos` native module. It is
  // only present on hosts that have built it against libkrb5 — so we
  // gracefully degrade when it is missing rather than blowing up at boot.
  type KerberosCtx = {
    step: (token: string) => Promise<string | null | undefined>;
    username: string;
  };
  type KerberosModule = {
    initializeServer: (spn: string) => Promise<KerberosCtx>;
  };
  let kerberosMod: KerberosModule | null = null;
  try {
    // The `kerberos` package has no bundled types and is intentionally
    // optional, so we resolve it via a runtime-only specifier and then
    // narrow it through our local interface.
    const specifier = "kerberos";
    const loaded: unknown = await import(/* @vite-ignore */ specifier);
    kerberosMod = loaded as KerberosModule;
  } catch {
    res.status(501).json({
      error:
        "Kerberos native module is not installed on this server. Install the `kerberos` npm package (requires libkrb5 / MIT-Kerberos) and restart.",
    });
    return;
  }

  const token = header.replace(/^Negotiate\s+/i, "").trim();
  try {
    const ctx = await kerberosMod!.initializeServer(spn);
    const next = await ctx.step(token);
    if (next) res.setHeader("WWW-Authenticate", `Negotiate ${next}`);
    const principal = ctx.username; // user@REALM
    const username = principal.split("@")[0];
    if (!username) {
      res.status(401).json({ error: "Empty principal" });
      return;
    }
    // Find or create the user, mark source as KERBEROS.
    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.username, username));
    // Apply AD group → role/department mapping. Kerberos doesn't expose
    // group memberships, so we have to do a follow-up bind-only LDAP
    // search. If LDAP isn't configured at all (no host/bind creds) we
    // can't apply mapping and we leave existing roles/departments alone;
    // when LDAP *is* configured the mapping becomes authoritative just
    // like the LDAP login path — empty groups means "user is in nothing
    // mapped" and we revoke accordingly.
    const ldapCfg = settings.ldap ?? {};
    const ldapAvailable =
      !!ldapCfg.host && !!ldapCfg.bindDn && !!ldapCfg.bindPassword;
    const kerbRoleMap = ldapCfg.groupRoleMap;
    const kerbDeptMap = ldapCfg.groupDepartmentMap;
    const useKerbRoleMap = ldapAvailable && hasMapping(kerbRoleMap);
    const useKerbDeptMap = ldapAvailable && hasMapping(kerbDeptMap);
    const kerbGroups =
      useKerbRoleMap || useKerbDeptMap
        ? await lookupLdapGroups(ldapCfg, username)
        : [];
    const kerbRoles = useKerbRoleMap
      ? mapGroupsToRoles(kerbGroups, kerbRoleMap)
      : null;
    // When role mapping is configured, a user with no matching group has no
    // authorised role and must not be allowed in.
    if (useKerbRoleMap && kerbRoles !== null && kerbRoles.length === 0) {
      await audit(null, "LOGIN_FAILED", "user", undefined, `KERBEROS: ${username}`, req.ip);
      res.status(401).json({ error: "Aucun groupe AD ne correspond à un rôle autorisé" });
      return;
    }
    const kerbDeptIds = useKerbDeptMap
      ? await mapGroupsToDepartmentIds(kerbGroups, kerbDeptMap)
      : null;
    let userRow = existing;
    if (!userRow) {
      const [created] = await db
        .insert(usersTable)
        .values({
          username,
          displayName: username,
          source: "KERBEROS",
          roles: kerbRoles ?? ["DEPT_USER"],
        })
        .returning();
      userRow = created;
      if (created && kerbDeptIds !== null)
        await syncUserDepartments(created.id, kerbDeptIds);
    } else {
      const update: Record<string, unknown> = {};
      if (existing.source !== "KERBEROS") update.source = "KERBEROS";
      if (kerbRoles !== null) update.roles = kerbRoles;
      if (Object.keys(update).length > 0) {
        await db.update(usersTable).set(update).where(eq(usersTable.id, existing.id));
      }
      if (kerbDeptIds !== null)
        await syncUserDepartments(existing.id, kerbDeptIds);
    }
    if (!userRow) {
      res.status(500).json({ error: "Failed to provision user" });
      return;
    }
    const sessionUser = await buildSessionUser(userRow.id);
    if (!sessionUser) {
      res.status(500).json({ error: "Failed to load user" });
      return;
    }
    req.session.user = sessionUser;
    await audit(
      sessionUser.id,
      "LOGIN",
      "user",
      sessionUser.id,
      "kerberos",
      req.ip,
    );
    res.json(sessionUser);
  } catch (err) {
    res.status(401).json({
      error: `Kerberos negotiation failed: ${(err as Error).message}`,
    });
  }
});

/**
 * First-deployment bootstrap.
 *
 * `GET /auth/setup-status` reports whether the database has *no* admin
 * yet. The login page polls this and switches to the "create admin"
 * form when the answer is `needsSetup: true`.
 *
 * `POST /auth/setup` creates the very first admin account. The endpoint
 * is intentionally unauthenticated, but it self-disables as soon as
 * any user with the `ADMIN` role exists, so it can never be used to
 * hijack an already-provisioned instance.
 */
router.get("/auth/setup-status", async (_req, res): Promise<void> => {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(sql`'ADMIN' = ANY(${usersTable.roles})`);
  res.json({ needsSetup: n === 0 });
});

/**
 * Public, unauthenticated subset of the app settings needed by the
 * login page (logo, app name, whether AD/LDAP and Kerberos are
 * enabled). The full GET /settings endpoint requires auth, but the
 * login form must know whether to show the "Use Active Directory"
 * toggle and the SSO probe before the user has signed in. Only
 * non-sensitive fields are returned — no host, base DN, bind DN,
 * passwords, or group mappings.
 */
router.get("/auth/public-config", async (_req, res): Promise<void> => {
  const s = await getSettings();
  res.json({
    appName: s.appName,
    logoDataUrl: s.logoDataUrl ?? null,
    ldap: {
      enabled: !!s.ldap?.enabled,
      kerberosEnabled: !!s.ldap?.kerberosEnabled,
    },
  });
});

router.post("/auth/setup", async (req, res): Promise<void> => {
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  const displayName =
    String(req.body?.displayName ?? "").trim() || "Administrator";
  const email = String(req.body?.email ?? "").trim() || null;
  if (!username || username.length < 2) {
    res.status(400).json({ error: "Username must be at least 2 characters." });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }
  // Hash outside the transaction (CPU-bound, ~100ms) so we don't hold
  // the advisory lock across it.
  const passwordHash = await hashPassword(password);
  // Serialize the entire bootstrap with a Postgres advisory lock —
  // the lock is auto-released when the transaction ends. Two concurrent
  // setup requests will queue here, and the second one will see an
  // existing admin and return 409 instead of creating a duplicate.
  // The numeric key is an arbitrary constant unique to this code path.
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7460185421)`);
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(usersTable)
      .where(sql`'ADMIN' = ANY(${usersTable.roles})`);
    if (n > 0) return { error: "ADMIN_EXISTS" as const };
    const [exists] = await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.username, username));
    if (exists) return { error: "USERNAME_TAKEN" as const };
    const [row] = await tx
      .insert(usersTable)
      .values({
        username,
        displayName,
        email,
        passwordHash,
        roles: ["ADMIN", "FINANCIAL_ALL"],
        source: "LOCAL",
      })
      .returning();
    return { created: row };
  });
  if ("error" in result) {
    if (result.error === "ADMIN_EXISTS") {
      res.status(409).json({
        error: "Setup already completed — an administrator exists.",
      });
    } else {
      res.status(409).json({ error: "Username is already taken." });
    }
    return;
  }
  const created = result.created;
  if (!created) {
    res.status(500).json({ error: "Failed to create administrator." });
    return;
  }
  const sessionUser = await buildSessionUser(created.id);
  if (!sessionUser) {
    res.status(500).json({ error: "Failed to load created user." });
    return;
  }
  req.session.user = sessionUser;
  await audit(
    sessionUser.id,
    "SETUP_ADMIN",
    "user",
    sessionUser.id,
    "first-boot",
    req.ip,
  );
  res.status(201).json(sessionUser);
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
