import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdfsState,
  adfsClientAuthentication,
  adfsLoginMethodCookie,
  callbackUrlForRedirect,
  clearAdfsLoginMethodCookie,
  decryptAdfsClientSecret,
  encryptAdfsClientSecret,
  mapAdfsClaims,
  signAdfsState,
  validateCaPem,
  validateAdfsCsrf,
  validateLocalReturnTarget,
  verifyAdfsState,
  resolveIdentityCandidate,
  sameExternalIdentity,
  isAdfsReplay,
} from "./adfs";
import { establishAuthenticatedSession } from "./auth";

test("return targets accept only local paths", () => {
  assert.equal(validateLocalReturnTarget("/workflows/7?tab=quotes"), "/workflows/7?tab=quotes");
  for (const value of ["https://evil.invalid", "//evil.invalid", "/\\evil", "/%zz", "/%0d%0a"]) {
    assert.equal(validateLocalReturnTarget(value), "/");
  }
  assert.equal(validateLocalReturnTarget("/workflows/7?tab=quotes#documents"), "/workflows/7?tab=quotes#documents");
});

test("AD FS state is signed, expires, and detects tampering", () => {
  const state = createAdfsState("/dashboard");
  const signed = signAdfsState(state);
  assert.deepEqual(verifyAdfsState(signed), state);
  assert.equal(verifyAdfsState(`${signed}x`), null);
  assert.equal(verifyAdfsState(signAdfsState({ ...state, exp: 1 }), 2), null);
  assert.equal(isAdfsReplay("one", 100), false);
  assert.equal(isAdfsReplay("one", 100), true);
});

test("client secrets are authenticated-encrypted and redaction-safe", () => {
  const encrypted = encryptAdfsClientSecret("not-a-token");
  assert.notEqual(encrypted, "not-a-token");
  assert.equal(decryptAdfsClientSecret(encrypted), "not-a-token");
  assert.equal(decryptAdfsClientSecret(`${encrypted}tampered`), null);
});

test("PEM and claim mapping validation", () => {
  assert.throws(() => validateCaPem("not pem"));
  const cert =
    "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END CERTIFICATE-----";
  assert.throws(() => validateCaPem(cert));
  const mapped = mapAdfsClaims(
    { sub: "subject-1", upn: "User@EXAMPLE", email: "user@example.test", name: "User" },
    "https://adfs.example.test/adfs",
    { usernameClaim: "upn", emailClaim: "email", displayNameClaim: "name" },
  );
  assert.deepEqual(mapped, {
    subject: "subject-1",
    issuer: "https://adfs.example.test/adfs",
    username: "User@EXAMPLE",
    email: "user@example.test",
    displayName: "User",
  });
});

test("identity candidates conflict across normalized username and email", () => {
  assert.deepEqual(resolveIdentityCandidate([7], [7]), { userId: 7, conflict: false });
  assert.deepEqual(resolveIdentityCandidate([7], [8]), { userId: null, conflict: true });
  assert.deepEqual(resolveIdentityCandidate([], []), { userId: null, conflict: false });
});

test("external identity tuple matching is exact and case-sensitive", () => {
  const identity = { provider: "adfs", issuer: "https://adfs.test/ADFS", subject: "User-1" };
  assert.equal(sameExternalIdentity(identity, { ...identity }), true);
  assert.equal(sameExternalIdentity(identity, { ...identity, issuer: "https://adfs.test/adfs" }), false);
  assert.equal(sameExternalIdentity(identity, { ...identity, subject: "user-1" }), false);
});

test("callback URL keeps configured origin/path and copies only query", () => {
  const callback = callbackUrlForRedirect(
    "https://registered.example.test/api/auth/adfs/callback?fixed=discarded",
    "?code=abc&state=xyz",
  );
  assert.equal(callback.href, "https://registered.example.test/api/auth/adfs/callback?code=abc&state=xyz");
});

test("CSRF requires the same session, header, and cookie value", () => {
  assert.equal(validateAdfsCsrf("safe", "safe", "safe"), true);
  assert.equal(validateAdfsCsrf("safe", "other", "safe"), false);
  assert.equal(validateAdfsCsrf(undefined, "safe", "safe"), false);
});

test("logout clears the AD FS preference cookie", () => {
  assert.match(adfsLoginMethodCookie(true), /Max-Age=31536000/);
  assert.match(clearAdfsLoginMethodCookie(true), /Max-Age=0/);
  assert.match(clearAdfsLoginMethodCookie(true), /Secure/);
});

test("public and confidential client auth helpers select the right token request mode", () => {
  const publicBody = new URLSearchParams();
  adfsClientAuthentication(null)({} as never, { client_id: "public" } as never, publicBody, new Headers());
  assert.equal(publicBody.get("client_id"), "public");
  assert.equal(publicBody.get("client_secret"), null);
  const confidentialBody = new URLSearchParams();
  adfsClientAuthentication("secret-value")(
    {} as never,
    { client_id: "confidential" } as never,
    confidentialBody,
    new Headers(),
  );
  assert.equal(confidentialBody.get("client_id"), "confidential");
  assert.equal(confidentialBody.get("client_secret"), "secret-value");
});

test("session establishment regenerates and saves before authentication is visible", async () => {
  const events: string[] = [];
  const session: {
    user?: unknown;
    regenerate(callback: (error?: Error) => void): void;
    save(callback: (error?: Error) => void): void;
  } = {
    regenerate(callback: (error?: Error) => void) {
      events.push("regenerate");
      callback();
    },
    save(callback: (error?: Error) => void) {
      events.push("save");
      callback();
    },
  };
  const req = { session } as never;
  const user = {
    id: 1,
    username: "user",
    displayName: "User",
    email: null,
    roles: ["DEPT_USER"],
    departmentIds: [1],
    source: "LOCAL",
  } as never;
  await establishAuthenticatedSession(req, user);
  assert.deepEqual(events, ["regenerate", "save"]);
  assert.equal(session.user, user);
});
