/**
 * Validate an application-local return target.  Keep the original path,
 * query, and fragment when it is valid, but never allow a value that can be
 * interpreted as an external URL by a browser.
 */
const LOCAL_RETURN_ORIGIN = "https://investflow.invalid";

export function safeLocalReturnTarget(raw: string | null | undefined): string {
  if (!raw) return "/";
  let target = raw;
  let decoded: string;
  try {
    // This also rejects malformed percent escapes before URL parsing.
    decoded = decodeURIComponent(target);
  } catch {
    return "/";
  }
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    /[\u0000-\u001f\u007f\\]/.test(target) ||
    /^[a-z][a-z\d+.-]*:/i.test(target) ||
    decoded.startsWith("//") ||
    /[\u0000-\u001f\u007f\\]/.test(decoded) ||
    /^[a-z][a-z\d+.-]*:/i.test(decoded)
  ) {
    return "/";
  }
  try {
    const parsed = new URL(target, LOCAL_RETURN_ORIGIN);
    // A relative URL inherits the sentinel origin.  Do not inspect `host`
    // here: it is deliberately non-empty after resolving against the
    // sentinel and that used to reject every valid local path.
    if (parsed.origin !== LOCAL_RETURN_ORIGIN) {
      return "/";
    }
  } catch {
    return "/";
  }
  return target || "/";
}

/** Backwards-compatible descriptive alias for callers outside auth-flow. */
export const getSafeReturnTarget = safeLocalReturnTarget;

export function getSafeNextPath(search: string): string {
  try {
    return safeLocalReturnTarget(new URLSearchParams(search).get("next"));
  } catch {
    return "/";
  }
}

export function getCurrentSafeReturnTarget(): string {
  if (typeof window === "undefined") return "/";
  return safeLocalReturnTarget(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
}

const REAUTH_GUARD = "investflow-adfs-reauth-attempted";
const LOGIN_METHOD = "investflow-login-method";
let logoutSuppressed = false;

export function markAdfsLoginStarted(): void {
  if (typeof sessionStorage === "undefined") return;
  // A deliberate click is a new attempt, even when an earlier automatic
  // attempt ended at the login page with an allowlisted callback error.
  sessionStorage.removeItem(REAUTH_GUARD);
  logoutSuppressed = false;
  sessionStorage.setItem(LOGIN_METHOD, "adfs");
}

export function clearAdfsReauthGuard(): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(REAUTH_GUARD);
}

export function clearAdfsLoginPreference(): void {
  logoutSuppressed = true;
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.removeItem(REAUTH_GUARD);
    sessionStorage.removeItem(LOGIN_METHOD);
  }
}

export function shouldStartAdfsReauth(loginMethod?: string | null): boolean {
  if (loginMethod !== "adfs" || typeof sessionStorage === "undefined") {
    return false;
  }
  if (sessionStorage.getItem(REAUTH_GUARD) === "1") return false;
  sessionStorage.setItem(REAUTH_GUARD, "1");
  return true;
}

export function getRememberedLoginMethod(): string | null {
  if (logoutSuppressed) return null;
  if (typeof document !== "undefined") {
    const method = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("investflow_login_method="))
      ?.split("=")[1];
    if (method === "adfs") return method;
  }
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(LOGIN_METHOD);
}