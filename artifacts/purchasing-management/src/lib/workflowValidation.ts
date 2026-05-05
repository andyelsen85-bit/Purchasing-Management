// Client-side mirror of the server's validateAdvancePrereqs in
// artifacts/api-server/src/routes/workflows.ts. Returns a *set of
// field keys* that are missing for the current step, so the UI can
// highlight inputs and uploads instead of just popping an error
// message. Keep the two implementations in sync — the server is
// authoritative, this only drives the UX.
import type { Workflow } from "./api";

export type MissingKey = string;

export interface DocSummary {
  kind: string;
  isCurrent?: boolean;
}

// Helpers -------------------------------------------------------------
function hasDoc(docs: DocSummary[], kind: string): boolean {
  return docs.some((d) => d.kind === kind && d.isCurrent !== false);
}

// Returns the set of missing field keys for the workflow's current
// step. Empty set means the workflow may advance.
export function computeMissingFields(
  wf: Workflow,
  docs: DocSummary[],
  branch: string | null,
): Set<MissingKey> {
  const out = new Set<MissingKey>();
  switch (wf.currentStep) {
    case "QUOTATION": {
      const quotes = wf.quotes ?? [];
      if (quotes.length === 0) {
        out.add("quotes");
      } else if (wf.threeQuoteRequired) {
        const filled = quotes.filter(
          (q) => q.amount != null && (q.companyId || q.companyName),
        );
        if (filled.length < 3) out.add("quotes");
        const winners = filled.filter((q) => q.winning);
        if (winners.length === 0) out.add("quotes-winning");
      } else {
        const first = quotes[0];
        if (
          !first ||
          first.amount == null ||
          !(first.companyId || first.companyName)
        )
          out.add("quotes");
      }
      if (!hasDoc(docs, "QUOTE")) out.add("doc:QUOTE");
      return out;
    }
    case "VALIDATING_QUOTE_FINANCIAL":
      if (!wf.managerApproved) out.add("managerApproved");
      return out;
    case "VALIDATING_BY_FINANCIAL":
      if (!wf.financialApproved) out.add("financialApproved");
      if (!branch) out.add("branch");
      return out;
    case "GT_INVEST":
      if (
        (wf as { gtInvestDecision?: string | null }).gtInvestDecision !== "OK"
      )
        out.add("gtInvestDecision");
      return out;
    case "ORDERING":
      // Order date is no longer required to advance — it's purely
      // informational. Keep the order number and the attached order
      // document as the only blocking prerequisites.
      if (!wf.orderNumber) out.add("orderNumber");
      if (!hasDoc(docs, "ORDER")) out.add("doc:ORDER");
      return out;
    case "DELIVERY":
      if (!wf.deliveredOn) out.add("deliveredOn");
      return out;
    case "INVOICE":
      if (!wf.invoiceNumber) out.add("invoiceNumber");
      if (wf.invoiceAmount == null) out.add("invoiceAmount");
      if (!wf.invoiceDate) out.add("invoiceDate");
      if (!hasDoc(docs, "INVOICE")) out.add("doc:INVOICE");
      return out;
    case "VALIDATING_INVOICE":
      if (!wf.invoiceValidated) out.add("invoiceValidated");
      return out;
    default:
      return out;
  }
}
