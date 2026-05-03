import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, departmentsTable, usersTable } from "@workspace/db";
import { requireAuth, requireRole, getUser } from "../middlewares/auth";
import { getSettings } from "../lib/settings";
import { runLdapDiagnostics, lookupLdapGroups } from "../lib/ldap";
import {
  mapGroupsToRoles,
  mapGroupsToDepartmentIds,
  syncUserDepartments,
  hasMapping,
} from "../lib/groupMapping";
import { audit } from "../lib/audit";

const router: IRouter = Router();

/**
 * POST /api/admin/ldap-test
 *
 * Diagnostic endpoint: runs a real LDAP search (and optional user bind)
 * against the *currently saved* LDAP configuration, then reports back
 * everything the login flow would see — connectivity, the user's DN,
 * their AD group memberships, and the roles + department codes that
 * would be granted by the configured group mapping. Admin-only.
 *
 * Returns a `steps[]` trace so the operator can see *exactly* which
 * phase failed (connect / bind / search / user-bind / groups) along
 * with the raw underlying error message — no need to dig through
 * server logs to debug LDAP configuration issues.
 *
 * Three modes:
 *  - `{ username, password }` — full bind-as-user check (mirrors
 *    `/auth/login` exactly).
 *  - `{ username }` only     — bind-DN search; useful to confirm the
 *    bind credentials work and that the user is findable, without the
 *    operator needing to know any user's password.
 *  - `{}` — bind-DN check only (no user lookup), confirms server reach.
 */
router.post(
  "/admin/ldap-test",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const settings = await getSettings();
    const cfg = settings.ldap ?? {};

    const username =
      typeof req.body?.username === "string" && req.body.username.trim()
        ? String(req.body.username).trim()
        : null;
    const password =
      typeof req.body?.password === "string" && req.body.password
        ? String(req.body.password)
        : null;

    const diag = await runLdapDiagnostics(cfg, username, password);

    const derivedRoles =
      diag.ok && diag.groups.length > 0 && hasMapping(cfg.groupRoleMap)
        ? mapGroupsToRoles(diag.groups, cfg.groupRoleMap)
        : [];
    const derivedDepartmentCodes =
      diag.ok && diag.groups.length > 0
        ? await resolveDeptCodes(diag.groups, cfg.groupDepartmentMap)
        : [];

    res.json({
      ok: diag.ok,
      stage: diag.stage,
      error: diag.error,
      displayName: diag.displayName,
      email: diag.email,
      groups: diag.groups,
      derivedRoles,
      derivedDepartmentCodes,
      steps: diag.steps,
    });
  },
);

async function resolveDeptCodes(
  groups: string[],
  mapping: Record<string, string> | null | undefined,
): Promise<string[]> {
  if (!hasMapping(mapping)) return [];
  const wanted = new Set<string>();
  const m = mapping ?? {};
  for (const [key, code] of Object.entries(m)) {
    if (!code) continue;
    const k = key.trim().toLowerCase();
    if (!k) continue;
    if (
      groups.some((g) => {
        const dnLower = g.toLowerCase();
        if (dnLower.includes(k)) return true;
        const cn = /^cn=([^,]+)/i.exec(g);
        return !!(cn && cn[1].toLowerCase().includes(k));
      })
    ) {
      wanted.add(code.trim().toLowerCase());
    }
  }
  if (wanted.size === 0) return [];
  const all = await db.select().from(departmentsTable);
  return all
    .filter((d) => wanted.has(d.code.trim().toLowerCase()))
    .map((d) => d.code);
}

/**
 * POST /api/admin/ldap-sync-roles
 *
 * Re-derives roles + department memberships from AD groups for every
 * LDAP-sourced user. Normally this happens at sign-in, but operators
 * who just edited an AD group (e.g. added a user to the GT Invest
 * notifications group) want the change reflected without making the
 * user log in again. Admin-only.
 *
 * Implementation:
 *  - Reads the saved LDAP config (no-op + 400 if mapping is disabled).
 *  - For each LDAP user, calls `lookupLdapGroups` (binds with the
 *    service account, no user password needed).
 *  - Re-applies `mapGroupsToRoles` and, if a department mapping is
 *    configured, `mapGroupsToDepartmentIds` + `syncUserDepartments`.
 *  - Returns a small summary (scanned / updated / skipped / errors)
 *    so the UI can surface the result without forcing a refresh.
 *  - Errors per user are collected, never thrown — one mis-configured
 *    user must not abort the whole sync.
 */
router.post(
  "/admin/ldap-sync-roles",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const settings = await getSettings();
    const cfg = settings.ldap ?? {};
    if (!cfg.enabled) {
      res
        .status(400)
        .json({ ok: false, scanned: 0, updated: 0, skipped: 0, errors: [], message: "LDAP is disabled in Settings." });
      return;
    }
    const useRoleMap = hasMapping(cfg.groupRoleMap);
    const useDeptMap = hasMapping(cfg.groupDepartmentMap);
    if (!useRoleMap && !useDeptMap) {
      res.status(400).json({
        ok: false,
        scanned: 0,
        updated: 0,
        skipped: 0,
        errors: [],
        message:
          "No Group → Role or Group → Department mapping is configured on the LDAP tab.",
      });
      return;
    }

    const ldapUsers = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.source, "LDAP"));

    let updated = 0;
    let skipped = 0;
    const errors: { username: string; error: string }[] = [];

    for (const u of ldapUsers) {
      try {
        const groups = await lookupLdapGroups(cfg, u.username);
        if (groups.length === 0) {
          // Could mean "user actually has no groups" *or* "we failed
          // silently". Either way we have nothing to apply, so just
          // skip — don't wipe roles based on an empty result.
          skipped++;
          continue;
        }
        let changed = false;
        const patch: Record<string, unknown> = {};
        if (useRoleMap) {
          const derived = mapGroupsToRoles(groups, cfg.groupRoleMap);
          const before = (u.roles ?? []).slice().sort().join(",");
          const after = derived.slice().sort().join(",");
          if (before !== after) {
            patch.roles = derived;
            changed = true;
          }
        }
        if (Object.keys(patch).length > 0) {
          await db.update(usersTable).set(patch).where(eq(usersTable.id, u.id));
        }
        if (useDeptMap) {
          const desiredIds = await mapGroupsToDepartmentIds(
            groups,
            cfg.groupDepartmentMap,
          );
          // syncUserDepartments is unconditionally authoritative — only
          // call it when a dept mapping is configured (matches the login
          // path's behaviour, keeps manual assignments alive otherwise).
          await syncUserDepartments(u.id, desiredIds);
          changed = true;
        }
        if (changed) updated++;
        else skipped++;
      } catch (err) {
        errors.push({ username: u.username, error: String(err) });
      }
    }

    await audit(
      getUser(req).id,
      "LDAP_SYNC_ROLES",
      "user",
      undefined,
      `scanned=${ldapUsers.length}, updated=${updated}, skipped=${skipped}, errors=${errors.length}`,
    );

    res.json({
      ok: true,
      scanned: ldapUsers.length,
      updated,
      skipped,
      errors,
      message: null,
    });
  },
);

export default router;
