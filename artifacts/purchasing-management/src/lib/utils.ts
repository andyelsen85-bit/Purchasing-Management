import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Extract a human-readable error message from a thrown value.
 * Handles `ApiError` from the generated client (which carries the
 * server's JSON body in `.data`), plain `Error` instances, and
 * anything else by falling back to a generic message.
 */
export function extractErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as {
      data?: { error?: unknown; message?: unknown } | null;
      status?: number;
      message?: unknown;
    };
    const data = e.data;
    if (data && typeof data === "object") {
      if (typeof data.error === "string" && data.error) return data.error;
      if (typeof data.message === "string" && data.message) return data.message;
    }
    if (e.status === 401) return "You are not signed in.";
    if (e.status === 403) {
      return "You do not have permission to do this. Ask an administrator.";
    }
    if (typeof e.message === "string" && e.message) return e.message;
  }
  return "Something went wrong. Please try again.";
}
