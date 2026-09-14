import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Request } from "express";

const scryptAsync = promisify(scrypt);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [salt, hex] = stored.split(":");
  if (!salt || !hex) return false;
  const expected = Buffer.from(hex, "hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(expected, derived);
}

export type Role =
  | "ADMIN"
  | "FINANCIAL_ALL"
  | "FINANCIAL_Achat"
  | "FINANCIAL_INVOICE"
  | "FINANCIAL_PAYMENT"
  | "DEPT_MANAGER"
  | "DEPT_USER"
  | "GT_INVEST"
  | "GT_INVEST_NOTIFICATIONS"
  | "READ_ONLY_DEPT"
  | "READ_ONLY_ALL";

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  email: string | null;
  roles: Role[];
  departmentIds: number[];
  source: string;
}

/**
 * Rotate the express-session identifier before attaching authentication state.
 * Regenerate and save are both callback APIs, so keep them in one helper to
 * prevent any login path from accidentally assigning a user to a pre-auth
 * session or responding before the new session is durable.
 */
export async function establishAuthenticatedSession(
  req: Request,
  user: SessionUser,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
  req.session.user = user;
  await new Promise<void>((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

declare module "express-session" {
  interface SessionData {
    user?: SessionUser;
    adfsCsrfToken?: string;
  }
}
