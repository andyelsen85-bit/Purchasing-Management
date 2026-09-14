import assert from "node:assert/strict";
import test from "node:test";
import {
  clearAdfsLoginPreference,
  getRememberedLoginMethod,
  markAdfsLoginStarted,
  safeLocalReturnTarget,
  shouldStartAdfsReauth,
} from "./auth-flow";

test("safe local return targets preserve path, query, and hash", () => {
  assert.equal(
    safeLocalReturnTarget("/workflows/7?tab=quotes#documents"),
    "/workflows/7?tab=quotes#documents",
  );
  assert.equal(
    safeLocalReturnTarget("/search?q=hello%20world#results"),
    "/search?q=hello%20world#results",
  );
});

test("safe local return targets reject external and malformed values", () => {
  for (const value of [
    "https://evil.invalid",
    "javascript:alert(1)",
    "//evil.invalid/path",
    "/\\evil.invalid",
    "/%5cevil.invalid",
    "/\u0000private",
    "/%0d%0aheader",
    "/%zz",
    "/%2f%2fevil.invalid",
  ]) {
    assert.equal(safeLocalReturnTarget(value), "/", value);
  }
});

test("automatic AD FS reauth is one attempt per tab and logout suppresses it", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "investflow_login_method=adfs" },
  });

  markAdfsLoginStarted();
  assert.equal(getRememberedLoginMethod(), "adfs");
  assert.equal(shouldStartAdfsReauth(getRememberedLoginMethod()), true);
  assert.equal(shouldStartAdfsReauth(getRememberedLoginMethod()), false);

  clearAdfsLoginPreference();
  assert.equal(getRememberedLoginMethod(), null);
  assert.equal(shouldStartAdfsReauth(getRememberedLoginMethod()), false);
});