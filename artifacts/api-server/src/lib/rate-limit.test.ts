import assert from "node:assert/strict";
import test from "node:test";
import {
  FixedWindowThrottle,
  ProgressiveFailureLimiter,
  normalizeLoginUsername,
} from "./rate-limit";

test("successful account reset does not erase aggregate IP history", () => {
  const limiter = new ProgressiveFailureLimiter({
    lockSeconds: [10],
    maxEntries: 10,
  });
  limiter.recordFailure(["ip:198.51.100.10", "user:alice"], 0);
  limiter.reset(["user:alice"]);
  assert.equal(limiter.check(["user:alice"], 1).allowed, true);
  assert.equal(limiter.check(["ip:198.51.100.10"], 1).allowed, false);
});

test("progressive lockout reports retry and expires deterministically", () => {
  const limiter = new ProgressiveFailureLimiter({ lockSeconds: [10] });
  limiter.recordFailure(["user:alice"], 1000);
  const locked = limiter.check(["user:alice"], 1001);
  assert.equal(locked.allowed, false);
  assert.equal(locked.retryAfterSeconds, 10);
  assert.equal(limiter.check(["user:alice"], 11001).allowed, true);
});

test("failure maps stay bounded and diagnostic throttle retries", () => {
  const limiter = new ProgressiveFailureLimiter({ maxEntries: 2 });
  limiter.recordFailure(["a", "b", "c"], 0);
  assert.equal(limiter.size(), 2);

  const throttle = new FixedWindowThrottle(5000, 2);
  assert.equal(throttle.consume("ip:user", 0).allowed, true);
  const retry = throttle.consume("ip:user", 1);
  assert.equal(retry.allowed, false);
  assert.equal(retry.retryAfterSeconds, 5);
  assert.equal(throttle.consume("ip:user", 5001).allowed, true);
});

test("diagnostic account keys normalize independently from trusted IP keys", () => {
  const limiter = new ProgressiveFailureLimiter({ lockSeconds: [10] });
  const ipKey = "ip:198.51.100.20";
  const accountKey = `user:${normalizeLoginUsername("  Alice@EXAMPLE  ")}`;
  limiter.recordFailure([ipKey, accountKey], 0);
  limiter.reset([accountKey]);
  assert.equal(limiter.check([accountKey], 1).allowed, true);
  assert.equal(limiter.check([ipKey], 1).allowed, false);
});