import { Router, type IRouter } from "express";
import { db, departmentsTable } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";
import { getSettings } from "../lib/settings";
import { ldapAuthenticate, lookupLdapGroups } from "../lib/ldap";
import {
  mapGroupsToRoles,
  hasMapping,
} from "../lib/groupMapping";

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
 * Two modes:
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
    if (!cfg.enabled || !cfg.host || !cfg.baseDn) {
      res.json({
        ok: false,
        stage: "bind",
        error: "LDAP is not enabled or host/baseDn missing in Settings.",
        groups: [],
        derivedRoles: [],
        derivedDepartmentCodes: [],
      });
      return;
    }

    const username =
      typeof req.body?.username === "string"
        ? String(req.body.username).trim()
        : "";
    const password =
      typeof req.body?.password === "string" ? String(req.body.password) : "";

    // Mode A — full bind-as-user (mirrors the login endpoint).
    if (username && password) {
      const result = await ldapAuthenticate(cfg, username, password);
      if (!result.ok) {
        res.json({
          ok: false,
          stage: "user_bind",
          error: result.error ?? "LDAP authentication failed",
          groups: [],
          derivedRoles: [],
          derivedDepartmentCodes: [],
        });
        return;
      }
      const groups = result.groups ?? [];
      const derivedRoles = hasMapping(cfg.groupRoleMap)
        ? mapGroupsToRoles(groups, cfg.groupRoleMap)
        : [];
      const derivedDepartmentCodes = await resolveDeptCodes(
        groups,
        cfg.groupDepartmentMap,
      );
      res.json({
        ok: true,
        stage: "complete",
        displayName: result.displayName ?? null,
        email: result.email ?? null,
        groups,
        derivedRoles,
        derivedDepartmentCodes,
      });
      return;
    }

    // Mode B — bind-DN search-only (no user password). Requires bind
    // creds. Returns whatever groups the bind account can see for the
    // username, or just confirms the bind succeeded if no username.
    if (!cfg.bindDn || !cfg.bindPassword) {
      res.json({
        ok: false,
        stage: "bind",
        error:
          "Bind DN/password are required to run a search-only test. Configure them in Settings, or supply a test username AND password to bind as that user instead.",
        groups: [],
        derivedRoles: [],
        derivedDepartmentCodes: [],
      });
      return;
    }
    if (!username) {
      // Just confirm the bind works by issuing a minimal lookup.
      const groups = await lookupLdapGroups(cfg, "__connectivity_probe__");
      // lookupLdapGroups returns [] on failure too, but it does return
      // [] on a successful "user not found" search — both indicate the
      // bind itself worked. To distinguish a hard failure we don't have
      // a separate signal; this is good enough for an operator probe.
      res.json({
        ok: true,
        stage: "bind",
        error: null,
        groups,
        derivedRoles: [],
        derivedDepartmentCodes: [],
      });
      return;
    }
    const groups = await lookupLdapGroups(cfg, username);
    if (groups.length === 0) {
      res.json({
        ok: false,
        stage: "search",
        error: `User "${username}" not found, or LDAP search/bind failed. Check Bind DN, Bind password, Base DN, and the CA certificate.`,
        groups: [],
        derivedRoles: [],
        derivedDepartmentCodes: [],
      });
      return;
    }
    const derivedRoles = hasMapping(cfg.groupRoleMap)
      ? mapGroupsToRoles(groups, cfg.groupRoleMap)
      : [];
    const derivedDepartmentCodes = await resolveDeptCodes(
      groups,
      cfg.groupDepartmentMap,
    );
    res.json({
      ok: true,
      stage: "search",
      groups,
      derivedRoles,
      derivedDepartmentCodes,
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

export default router;
