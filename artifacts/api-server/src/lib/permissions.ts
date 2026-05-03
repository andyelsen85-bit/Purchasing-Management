import type { Role, SessionUser } from "./auth";

export const WORKFLOW_STEPS = [
  "NEW",
  "QUOTATION",
  "VALIDATING_QUOTE_FINANCIAL",
  "VALIDATING_BY_FINANCIAL",
  "GT_INVEST",
  "ORDERING",
  "DELIVERY",
  "INVOICE",
  "VALIDATING_INVOICE",
  "PAYMENT",
  "DONE",
  "REJECTED",
] as const;
export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];

export function hasRole(user: SessionUser, ...roles: Role[]): boolean {
  return roles.some((r) => user.roles.includes(r));
}

export function isAdmin(user: SessionUser): boolean {
  return hasRole(user, "ADMIN");
}

export function canViewAll(user: SessionUser): boolean {
  return hasRole(
    user,
    "ADMIN",
    "FINANCIAL_ALL",
    "FINANCIAL_INVOICE",
    "FINANCIAL_PAYMENT",
    "READ_ONLY_ALL",
  );
}

export function canSeeWorkflow(
  user: SessionUser,
  workflowDeptId: number,
): boolean {
  if (canViewAll(user)) return true;
  return user.departmentIds.includes(workflowDeptId);
}

// Who can advance / write at each step
export function canActOnStep(
  user: SessionUser,
  step: WorkflowStep,
  workflowDeptId: number,
): boolean {
  if (isAdmin(user)) return true;
  switch (step) {
    case "NEW":
    case "QUOTATION":
      return (
        (hasRole(user, "DEPT_USER", "DEPT_MANAGER") &&
          user.departmentIds.includes(workflowDeptId)) ||
        hasRole(user, "FINANCIAL_ALL")
      );
    case "VALIDATING_QUOTE_FINANCIAL":
      return (
        (hasRole(user, "DEPT_MANAGER") &&
          user.departmentIds.includes(workflowDeptId)) ||
        hasRole(user, "FINANCIAL_ALL")
      );
    case "VALIDATING_BY_FINANCIAL":
      return hasRole(user, "FINANCIAL_ALL");
    case "GT_INVEST":
      return hasRole(user, "GT_INVEST", "FINANCIAL_ALL");
    case "ORDERING":
      // Step 5 — only Financial-All places the order. Department users
      // can still *view* the workflow (canSeeWorkflow) but cannot act.
      return hasRole(user, "FINANCIAL_ALL");
    case "DELIVERY":
      // Step 6 — the requesting department records receipt of goods.
      return (
        (hasRole(user, "DEPT_USER", "DEPT_MANAGER") &&
          user.departmentIds.includes(workflowDeptId)) ||
        hasRole(user, "FINANCIAL_ALL")
      );
    case "INVOICE":
      // Step 7 — Financial-Invoice records the supplier invoice.
      return hasRole(user, "FINANCIAL_ALL", "FINANCIAL_INVOICE");
    case "VALIDATING_INVOICE":
      return hasRole(user, "FINANCIAL_ALL", "FINANCIAL_INVOICE");
    case "PAYMENT":
      return hasRole(user, "FINANCIAL_ALL", "FINANCIAL_PAYMENT");
    case "DONE":
    case "REJECTED":
      // Terminal steps — no one can act except via Undo (handled in
      // the dedicated /undo endpoint, which uses canUndo).
      return false;
  }
  return false;
}

export function canUndo(user: SessionUser): boolean {
  return hasRole(user, "ADMIN", "FINANCIAL_ALL");
}

/**
 * Anyone allowed to act on the workflow's *current* step can edit notes /
 * upload documents on it. Read-only roles (READ_ONLY_*) and pure
 * cross-department viewers (FINANCIAL_INVOICE/PAYMENT outside their
 * step) can see the workflow but cannot mutate it.
 */
export function canEditWorkflow(
  user: SessionUser,
  workflowDeptId: number,
  currentStep: WorkflowStep,
): boolean {
  if (isAdmin(user)) return true;
  if (hasRole(user, "READ_ONLY_DEPT", "READ_ONLY_ALL")) return false;
  return canActOnStep(user, currentStep, workflowDeptId);
}

/**
 * Who is allowed to *create* a new workflow in `departmentId`.
 * - ADMIN / FINANCIAL_ALL: any department
 * - DEPT_USER / DEPT_MANAGER: only their own department(s)
 * - everyone else (read-only, GT_INVEST, FINANCIAL_INVOICE/PAYMENT): no
 */
export function canCreateInDepartment(
  user: SessionUser,
  departmentId: number,
): boolean {
  if (isAdmin(user) || hasRole(user, "FINANCIAL_ALL")) return true;
  if (
    hasRole(user, "DEPT_USER", "DEPT_MANAGER") &&
    user.departmentIds.includes(departmentId)
  )
    return true;
  return false;
}

/**
 * Full master-data control: edit company fields, delete companies,
 * delete contacts. Admin / FINANCIAL_ALL only.
 */
export function canEditMasterData(user: SessionUser): boolean {
  return hasRole(user, "ADMIN", "FINANCIAL_ALL");
}

/**
 * Adding a supplier (company) and adding/editing its contacts is
 * available to anyone who actually contributes to workflows — i.e.
 * everybody except the read-only roles. Department users frequently
 * onboard new suppliers themselves and need to keep contact info up
 * to date; deletion / company-field edits remain admin-only.
 */
export function canAddSupplier(user: SessionUser): boolean {
  if (canEditMasterData(user)) return true;
  return !hasRole(user, "READ_ONLY_DEPT", "READ_ONLY_ALL");
}

/** Add or update a contact. Same audience as `canAddSupplier`. */
export function canEditContact(user: SessionUser): boolean {
  return canAddSupplier(user);
}

export function nextStep(
  current: WorkflowStep,
  branch?: string | null,
): WorkflowStep | null {
  switch (current) {
    case "NEW":
      return "QUOTATION";
    case "QUOTATION":
      return "VALIDATING_QUOTE_FINANCIAL";
    case "VALIDATING_QUOTE_FINANCIAL":
      return "VALIDATING_BY_FINANCIAL";
    case "VALIDATING_BY_FINANCIAL":
      // Branch chooser
      if (branch === "GT_INVEST") return "GT_INVEST";
      return "ORDERING"; // K_ORDER branch (or default)
    case "GT_INVEST":
      return "ORDERING";
    case "ORDERING":
      return "DELIVERY";
    case "DELIVERY":
      return "INVOICE";
    case "INVOICE":
      return "VALIDATING_INVOICE";
    case "VALIDATING_INVOICE":
      return "PAYMENT";
    case "PAYMENT":
      return "DONE";
    case "DONE":
    case "REJECTED":
      return null;
  }
  return null;
}
