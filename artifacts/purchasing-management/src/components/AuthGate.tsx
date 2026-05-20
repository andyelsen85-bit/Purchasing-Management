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
      // Preserve the destination (path + query + hash) so the user
      // lands back on the page they originally requested — typically
      // a workflow detail page reached from a notification email.
      const search = typeof window !== "undefined" ? window.location.search : "";
      const hash = typeof window !== "undefined" ? window.location.hash : "";
      const dest = `${location}${search}${hash}`;
      const next =
        dest && dest !== "/" ? `?next=${encodeURIComponent(dest)}` : "";
      setLocation(`/login${next}`);
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
