import { useEffect } from "react";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { useGetSession, getGetSessionQueryKey } from "@/lib/api";

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  email?: string | null;
  roles: string[];
  departmentIds: number[];
  source: string;
}

interface Props {
  children: (user: SessionUser) => React.ReactNode;
}

export function AuthGate({ children }: Props) {
  const [location, setLocation] = useLocation();
  const { data, isLoading, isError } = useGetSession({
    query: { queryKey: getGetSessionQueryKey(), retry: false },
  });

  useEffect(() => {
    if (!isLoading && (isError || !data?.user) && location !== "/login") {
      setLocation("/login");
    }
  }, [isLoading, isError, data, location, setLocation]);

  if (location === "/login") {
    return <>{children({} as SessionUser)}</>;
  }

  if (isLoading) {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-background"
        data-testid="status-auth-loading"
      >
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <div className="text-sm">Loading session…</div>
        </div>
      </div>
    );
  }

  if (!data?.user) {
    return null;
  }

  return <>{children(data.user as SessionUser)}</>;
}
