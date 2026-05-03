import { createContext, useCallback, useContext, useMemo, useState } from "react";

// Per-workflow context that tracks which field keys are "missing"
// after a failed Next Step / approve attempt. Step panels read it to
// add a red border (and supplemental "Required" hint) on inputs and
// uploaders; the action button writes to it.
interface Ctx {
  missing: Set<string>;
  setMissing: (keys: Set<string>) => void;
  clearKey: (key: string) => void;
}

const MissingFieldsCtx = createContext<Ctx | null>(null);

export function MissingFieldsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [missing, setMissingState] = useState<Set<string>>(new Set());
  const setMissing = useCallback((keys: Set<string>) => {
    setMissingState(new Set(keys));
  }, []);
  const clearKey = useCallback((key: string) => {
    setMissingState((cur) => {
      if (!cur.has(key)) return cur;
      const next = new Set(cur);
      next.delete(key);
      return next;
    });
  }, []);
  const value = useMemo<Ctx>(
    () => ({ missing, setMissing, clearKey }),
    [missing, setMissing, clearKey],
  );
  return (
    <MissingFieldsCtx.Provider value={value}>
      {children}
    </MissingFieldsCtx.Provider>
  );
}

export function useMissingFields(): Ctx {
  const ctx = useContext(MissingFieldsCtx);
  if (!ctx) {
    // Outside a provider — return a no-op so step panels can be
    // rendered standalone (e.g. unit tests) without crashing.
    return {
      missing: new Set(),
      setMissing: () => {},
      clearKey: () => {},
    };
  }
  return ctx;
}

// Small red asterisk rendered next to mandatory field labels so the
// user sees up front what is required to advance.
export function RequiredMark() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 text-destructive"
      data-testid="required-mark"
    >
      *
    </span>
  );
}

// className helper for inputs/select triggers/file rows. Adds a red
// ring + border when the given key is currently flagged missing.
export function missingInputCls(isMissing: boolean): string {
  return isMissing
    ? "border-destructive ring-1 ring-destructive focus-visible:ring-destructive"
    : "";
}
