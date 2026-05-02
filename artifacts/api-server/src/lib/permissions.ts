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
    case "DELIVERY":
      return (
        (hasRole(user, "DEPT_USER", "DEPT_MANAGER") &&
          user.departmentIds.includes(workflowDeptId)) ||
        hasRole(user, "FINANCIAL_ALL")
      );
    case "INVOICE":
      return (
        (hasRole(user, "DEPT_USER", "DEPT_MANAGER") &&
          user.departmentIds.includes(workflowDeptId)) ||
        hasRole(user, "FINANCIAL_ALL", "FINANCIAL_INVOICE")
      );
    case "VALIDATING_INVOICE":
      return hasRole(user, "FINANCIAL_ALL", "FINANCIAL_INVOICE");
    case "PAYMENT":
      return hasRole(user, "FINANCIAL_ALL", "FINANCIAL_PAYMENT");
    case "DONE":
      return false;
  }
  return false;
}

export function canUndo(user: SessionUser): boolean {
  return hasRole(user, "ADMIN", "FINANCIAL_ALL");
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
      return null;
  }
  return null;
}
