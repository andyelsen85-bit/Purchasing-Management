export const STEPS = [
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
export type Step = (typeof STEPS)[number];

// Forward, user-facing flow — mirrors the server's ACTIVE_WORKFLOW_STEPS.
// Use this anywhere UI needs to enumerate the active linear flow; STEPS
// is retained as the recognised-value catalogue (incl. legacy NEW and
// terminal REJECTED) for typing and label lookups only.
export const ACTIVE_STEPS = [
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
] as const satisfies readonly Step[];

export const STEP_LABEL: Record<Step, string> = {
  NEW: "Nouveau",
  QUOTATION: "Offre de prix",
  VALIDATING_QUOTE_FINANCIAL: "Validation Responsable",
  VALIDATING_BY_FINANCIAL: "Validation Financière",
  GT_INVEST: "GT Invest",
  ORDERING: "Commande",
  DELIVERY: "Livraison",
  INVOICE: "Facture",
  VALIDATING_INVOICE: "Validation Facture",
  PAYMENT: "Paiement",
  DONE: "Terminé",
  REJECTED: "Clôturé",
};

export const PRIORITY_LABEL: Record<string, string> = {
  LOW: "Faible",
  NORMAL: "Normal",
  HIGH: "Élevée",
  URGENT: "Urgent",
};

export const PRIORITY_TONE: Record<string, string> = {
  LOW: "bg-muted text-muted-foreground",
  NORMAL: "bg-secondary text-secondary-foreground",
  HIGH: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  URGENT: "bg-destructive/15 text-destructive",
};

export const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Administrator",
  FINANCIAL_ALL: "Financial — All",
  FINANCIAL_INVOICE: "Financial — Invoice",
  FINANCIAL_PAYMENT: "Financial — Payment",
  DEPT_MANAGER: "Department Manager",
  DEPT_USER: "Department User",
  GT_INVEST: "GT Invest",
  READ_ONLY_DEPT: "Read-only (Dept)",
  READ_ONLY_ALL: "Read-only (All)",
};

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
