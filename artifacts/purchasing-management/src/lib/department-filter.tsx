import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type DepartmentSelection = number | "ALL";

interface Ctx {
  selectedDeptId: DepartmentSelection;
  setSelectedDeptId: (v: DepartmentSelection) => void;
}

const DepartmentFilterContext = createContext<Ctx | null>(null);

const STORAGE_KEY = "global-department-filter";

export function DepartmentFilterProvider({ children }: { children: ReactNode }) {
  const [selectedDeptId, setSelectedDeptId] = useState<DepartmentSelection>(() => {
    if (typeof localStorage === "undefined") return "ALL";
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || raw === "ALL") return "ALL";
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : "ALL";
  });
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, String(selectedDeptId));
  }, [selectedDeptId]);
  return (
    <DepartmentFilterContext.Provider value={{ selectedDeptId, setSelectedDeptId }}>
      {children}
    </DepartmentFilterContext.Provider>
  );
}

export function useDepartmentFilter(): Ctx {
  const ctx = useContext(DepartmentFilterContext);
  if (!ctx) throw new Error("useDepartmentFilter must be used inside DepartmentFilterProvider");
  return ctx;
}
