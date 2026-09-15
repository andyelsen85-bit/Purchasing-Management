import type { NextFunction, Request, Response } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const CSRF_COOKIE = "investflow_csrf";

function parseCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function issueCsrfCookie(req: Request, res: Response): string {
  const token = req.session.csrfToken ?? cryptoToken();
  req.session.csrfToken = token;
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: "lax",
    secure: req.secure,
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  return token;
}

function cryptoToken(): string {
  return randomBytes(32).toString("base64url");
}

function sameOrigin(req: Request): boolean {
  const supplied = req.get("origin") ?? req.get("referer");
  // A browser POST supplies Origin (or, for older browsers, Referer).  Do
  // not treat a missing provenance header as same-origin for the logout
  // recovery path; callers with a session token can still log out normally.
  if (!supplied) return false;
  try {
    const url = new URL(supplied);
    const host = req.get("host");
    return !!host && url.host === host;
  } catch {
    return false;
  }
}

function validToken(req: Request): boolean {
  const expected = req.session.csrfToken;
  const cookie = parseCookie(req.get("cookie"), CSRF_COOKIE);
  const header = req.get("x-csrf-token");
  if (!expected || !cookie || !header) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(cookie);
  const c = Buffer.from(header);
  if (a.length !== b.length || a.length !== c.length) return false;
  return timingSafeEqual(a, b) && timingSafeEqual(a, c);
}

/**
 * All state-changing API requests pass here before route handlers.  Login
 * and first-boot setup intentionally establish a new session and therefore
 * cannot present a token yet. Logout accepts a same-origin request without a
 * token as a recovery path, but still validates a token whenever supplied.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }
  const path = req.path;
  if (path === "/auth/login" || path === "/auth/setup") {
    next();
    return;
  }
  if (path === "/auth/logout") {
    if (sameOrigin(req) && (!req.get("x-csrf-token") || validToken(req))) {
      next();
      return;
    }
    res.status(403).json({ error: "CSRF token required" });
    return;
  }
  if (!validToken(req)) {
    res.status(403).json({ error: "CSRF token required" });
    return;
  }
  next();
}

export { sameOrigin };