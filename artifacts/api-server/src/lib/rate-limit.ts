/**
 * Small bounded, in-process abuse controls for authentication endpoints.
 *
 * These maps intentionally do not claim to be a distributed rate limiter:
 * production deployments with multiple API workers should put equivalent
 * limits at the edge or replace this with a shared store.  Entries are
 * expired and evicted at a fixed bound so attacker-controlled keys cannot
 * grow memory without limit.
 */
export interface LimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface FailureEntry {
  failures: number;
  lockedUntil: number;
  lastSeen: number;
}

export class ProgressiveFailureLimiter {
  private readonly entries = new Map<string, FailureEntry>();
  private readonly maxEntries: number;
  private readonly windowMs: number;
  private readonly lockSeconds: number[];

  constructor(options?: {
    maxEntries?: number;
    windowMs?: number;
    lockSeconds?: number[];
  }) {
    this.maxEntries = options?.maxEntries ?? 10_000;
    this.windowMs = options?.windowMs ?? 15 * 60_000;
    this.lockSeconds = options?.lockSeconds ?? [15, 30, 60, 300, 900];
  }

  check(keys: string[], now = Date.now()): LimitResult {
    this.prune(now);
    let retryAfter = 0;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry && entry.lockedUntil > now) {
        retryAfter = Math.max(retryAfter, Math.ceil((entry.lockedUntil - now) / 1000));
      }
    }
    return { allowed: retryAfter === 0, retryAfterSeconds: retryAfter };
  }

  recordFailure(keys: string[], now = Date.now()): void {
    this.prune(now);
    for (const key of keys) {
      const previous = this.entries.get(key);
      const failures =
        previous && now - previous.lastSeen <= this.windowMs
          ? previous.failures + 1
          : 1;
      const lockIndex = Math.min(failures - 1, this.lockSeconds.length - 1);
      const lockedUntil = now + this.lockSeconds[lockIndex]! * 1000;
      this.entries.delete(key);
      this.entries.set(key, { failures, lockedUntil, lastSeen: now });
    }
    this.bound();
  }

  reset(keys: string[]): void {
    for (const key of keys) this.entries.delete(key);
  }

  size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeen > this.windowMs && entry.lockedUntil <= now) {
        this.entries.delete(key);
      }
    }
  }

  private bound(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export class FixedWindowThrottle {
  private readonly entries = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly intervalMs: number;

  constructor(intervalMs = 5_000, maxEntries = 10_000) {
    this.intervalMs = intervalMs;
    this.maxEntries = maxEntries;
  }

  consume(key: string, now = Date.now()): LimitResult {
    for (const [existing, timestamp] of this.entries) {
      if (now - timestamp > this.intervalMs) this.entries.delete(existing);
    }
    const previous = this.entries.get(key);
    if (previous !== undefined && now - previous < this.intervalMs) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((this.intervalMs - (now - previous)) / 1000)),
      };
    }
    this.entries.delete(key);
    this.entries.set(key, now);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  size(): number {
    return this.entries.size;
  }
}

export function normalizeLoginUsername(username: string): string {
  return username.trim().toLocaleLowerCase();
}