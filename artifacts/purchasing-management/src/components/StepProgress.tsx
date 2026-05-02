import { Check } from "lucide-react";
import { STEPS, STEP_LABEL, type Step } from "@/lib/steps";

interface Props {
  current: Step;
  branch?: string | null;
}

export function StepProgress({ current, branch }: Props) {
  const flow: Step[] = (() => {
    if (branch === "GT_INVEST") {
      return [
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
      ];
    }
    return [
      "NEW",
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

  // Rejected workflows render their own banner instead of the step
  // ribbon — the linear progress bar is meaningless once the workflow
  // is closed.
  if (current === "REJECTED") {
    return (
      <div
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
        data-testid="status-step-progress"
      >
        Rejected — workflow closed
      </div>
    );
  }

  const currentIdx = flow.indexOf(current);
  const totalIdx = STEPS.indexOf(current);

  return (
    <div className="space-y-2" data-testid="status-step-progress">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <div>
          Step {Math.max(1, totalIdx + 1)} of {flow.length}
        </div>
        <div>{STEP_LABEL[current]}</div>
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
                    ? "bg-primary/10 border-primary/30 text-primary"
                    : active
                      ? "bg-primary text-primary-foreground border-primary shadow animate-pulse"
                      : "bg-muted/40 border-border text-muted-foreground"
                }`}
              >
                {done ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <span className="truncate">{STEP_LABEL[step]}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
