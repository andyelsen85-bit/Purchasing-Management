import type { Request, Response, NextFunction } from "express";
import type { Role, SessionUser } from "../lib/auth";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  "/auth/session",
  "/auth/csrf",
  "/auth/logout",
  "/auth/change-password",
]);

async function refreshAuthoritativeUser(req: Request): Promise<SessionUser | null> {
  const sessionUser = req.session?.user;
  if (!sessionUser) return null;
  const [row] = await db
    .select({ mustChangePassword: usersTable.mustChangePassword })
    .from(usersTable)
    .where(eq(usersTable.id, sessionUser.id));
  if (!row) return null;
  const current = {
    ...sessionUser,
    mustChangePassword: !!row.mustChangePassword,
  };
  req.session.user = current;
  return current;
}

async function enforcePasswordChange(
  req: Request,
  res: Response,
): Promise<SessionUser | null> {
  const user = await refreshAuthoritativeUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  if (user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED_PATHS.has(req.path)) {
    res.status(403).json({
      error: "Password change required",
      code: "PASSWORD_CHANGE_REQUIRED",
    });
    return null;
  }
  return user;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (await enforcePasswordChange(req, res)) next();
  } catch (error) {
    next(error);
  }
}

export function requireRole(...roles: Role[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = await enforcePasswordChange(req, res);
      if (!user) return;
      if (!roles.some((r) => user.roles.includes(r))) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function getUser(req: Request): SessionUser {
  // Caller must have called requireAuth first.
  return req.session!.user!;
}
