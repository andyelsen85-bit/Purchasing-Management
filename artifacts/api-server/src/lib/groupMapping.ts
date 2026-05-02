import { db, departmentsTable, userDepartmentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { Role } from "./auth";

const VALID_ROLES: ReadonlySet<Role> = new Set<Role>([
  "ADMIN",
  "FINANCIAL_ALL",
  "FINANCIAL_INVOICE",
  "FINANCIAL_PAYMENT",
  "DEPT_MANAGER",
  "DEPT_USER",
  "GT_INVEST",
  "READ_ONLY_DEPT",
  "READ_ONLY_ALL",
]);

/**
 * Match a single AD group DN against a configured key. Keys are matched
 * case-insensitively against either the full DN or the leftmost CN
 * component, whichever the operator finds easiest to author. Substring
 * matches succeed too — `Finance` matches `CN=Finance Team,OU=...`.
 */
function groupMatches(groupDn: string, key: string): boolean {
  const k = key.trim().toLowerCase();
  if (!k) return false;
  const dnLower = groupDn.toLowerCase();
  if (dnLower.includes(k)) return true;
  const cnMatch = /^cn=([^,]+)/i.exec(groupDn);
  if (cnMatch && cnMatch[1].toLowerCase().includes(k)) return true;
  return false;
}

/**
 * Translate AD group memberships into app roles using the operator's
 * configured mapping. The default `DEPT_USER` role is always included
 * unless the mapping explicitly assigns something else, mirroring how
 * the LDAP user-provisioning path used to behave before group mapping
 * existed. Unknown role names in the mapping are silently dropped so
 * a typo in Settings can never elevate a user.
 */
export function mapGroupsToRoles(
  groups: string[],
  mapping: Record<string, string> | null | undefined,
): Role[] {
  const roles = new Set<Role>(["DEPT_USER"]);
  if (!mapping) return Array.from(roles);
  for (const [key, roleName] of Object.entries(mapping)) {
    const role = roleName as Role;
    if (!VALID_ROLES.has(role)) continue;
    if (groups.some((g) => groupMatches(g, key))) roles.add(role);
  }
  return Array.from(roles);
}

/**
 * Resolve department codes from AD group memberships using the operator's
 * configured mapping, then look those codes up in the departments table.
 * Returns the matching department IDs (no duplicates). Codes that don't
 * exist in the database are dropped — Settings ships an inline editor so
 * the operator can add them.
 */
export async function mapGroupsToDepartmentIds(
  groups: string[],
  mapping: Record<string, string> | null | undefined,
): Promise<number[]> {
  if (!mapping) return [];
  const wantedCodes = new Set<string>();
  for (const [key, code] of Object.entries(mapping)) {
    if (!code) continue;
    if (groups.some((g) => groupMatches(g, key)))
      wantedCodes.add(code.trim().toLowerCase());
  }
  if (wantedCodes.size === 0) return [];
  const allDepts = await db.select().from(departmentsTable);
  const matched = allDepts.filter((d) =>
    wantedCodes.has(d.code.trim().toLowerCase()),
  );
  return matched.map((d) => d.id);
}

/**
 * Replace a user's department memberships with `desiredIds`. Idempotent
 * and unconditionally authoritative — passing an empty array clears all
 * memberships, which is the correct behaviour when AD says the user is
 * no longer in any mapped group. Callers MUST gate this on "mapping is
 * configured" if they want to preserve manual additions for tenants
 * that haven't set up group→department mapping yet.
 */
export async function syncUserDepartments(
  userId: number,
  desiredIds: number[],
): Promise<void> {
  await db
    .delete(userDepartmentsTable)
    .where(eq(userDepartmentsTable.userId, userId));
  if (desiredIds.length === 0) return;
  await db
    .insert(userDepartmentsTable)
    .values(desiredIds.map((departmentId) => ({ userId, departmentId })));
}

/** True when the operator has configured at least one entry. */
export function hasMapping(
  m: Record<string, string> | null | undefined,
): boolean {
  return !!m && Object.keys(m).length > 0;
}
