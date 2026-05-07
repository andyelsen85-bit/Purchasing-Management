import { STEP_LABEL, type Step } from "@/lib/steps";

interface Props {
  current: Step;
  branch?: string | null;
}

export function StepProgress({ current, branch }: Props) {
  // The legacy "NEW" step has been removed from the active flow —
  // workflows are now created directly in QUOTATION. NEW is still
  // accepted as `current` for historical rows and is treated as
  // equivalent to QUOTATION for ribbon-positioning purposes.
  const flow: Step[] = (() => {
    if (branch === "GT_INVEST") {
      return [
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
      ];
    }
    return [
      "QUOTATION",
      "VALIDATING_QUOTE_FINANCIAL",
      "VALIDATING_BY_FINANCIAL",
      "ORDERING",
      "DELIVERY",
      "INVOICE",
      "VALIDATING_INVOICE",
      "PAYMENT",
      "DONE",
    ];
  })();
  const effective: Step = current === "NEW" ? "QUOTATION" : current;

  // Rejected workflows render their own banner instead of the step
  // ribbon — the linear progress bar is meaningless once the workflow
  // is closed.
  if (current === "REJECTED") {
    return (
      <div
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
        data-testid="status-step-progress"
      >
        Demande clôturée
      </div>
    );
  }

  const currentIdx = flow.indexOf(effective);
  // Counter is computed from the active flow (not the global STEPS
  // catalogue, which still contains legacy/terminal entries like NEW
  // and REJECTED) so the displayed ordinal matches the visible ribbon.
  const ordinal = currentIdx >= 0 ? currentIdx + 1 : 1;

  return (
    <div className="space-y-2" data-testid="status-step-progress">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <div>
          Step {ordinal} of {flow.length}
        </div>
        <div>{STEP_LABEL[effective]}</div>
      </div>
      <div className="flex items-stretch gap-1">
        {flow.map((step, idx) => {
          const done = idx < currentIdx;
          const active = idx === currentIdx;
          return (
            <div
              key={step}
              className="group relative flex-1 min-w-0"
              title={STEP_LABEL[step]}
              data-testid={`badge-step-${step}`}
            >
              <div
                className={`flex h-9 items-center justify-center rounded-md border px-2 text-[11px] font-medium transition ${
                  done
                    ? "bg-emerald-600 text-white border-emerald-700"
                    : active
                      ? "bg-primary text-primary-foreground border-primary shadow animate-pulse"
                      : "bg-muted/40 border-border text-muted-foreground"
                }`}
              >
                <span className="truncate">{STEP_LABEL[step]}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
