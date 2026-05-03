import { Router, type IRouter } from "express";
import { db, departmentsTable } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";
import { getSettings } from "../lib/settings";
import { runLdapDiagnostics } from "../lib/ldap";
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

export default router;
