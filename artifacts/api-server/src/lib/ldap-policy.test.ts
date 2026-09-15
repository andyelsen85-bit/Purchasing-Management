import assert from "node:assert/strict";
import test from "node:test";
import { ldapTlsPolicy } from "./ldap";

const original = {
  nodeEnv: process.env.NODE_ENV,
  reason: process.env.LDAP_TLS_INSECURE_EXCEPTION_REASON,
  expires: process.env.LDAP_TLS_INSECURE_EXCEPTION_EXPIRES_AT,
};

test.afterEach(() => {
  if (original.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = original.nodeEnv;
  if (original.reason === undefined) delete process.env.LDAP_TLS_INSECURE_EXCEPTION_REASON;
  else process.env.LDAP_TLS_INSECURE_EXCEPTION_REASON = original.reason;
  if (original.expires === undefined) delete process.env.LDAP_TLS_INSECURE_EXCEPTION_EXPIRES_AT;
  else process.env.LDAP_TLS_INSECURE_EXCEPTION_EXPIRES_AT = original.expires;
});

test("production rejects insecure LDAP without a valid exception", () => {
  process.env.NODE_ENV = "production";
  delete process.env.LDAP_TLS_INSECURE_EXCEPTION_REASON;
  delete process.env.LDAP_TLS_INSECURE_EXCEPTION_EXPIRES_AT;
  assert.equal(ldapTlsPolicy({ encryption: "plain", skipVerify: false }).allowed, false);
  assert.equal(ldapTlsPolicy({ encryption: "ldaps", skipVerify: true }).allowed, false);
});

test("exception requires a reason and future expiry and exposes a warning", () => {
  process.env.NODE_ENV = "production";
  process.env.LDAP_TLS_INSECURE_EXCEPTION_REASON = "incident INC-123";
  process.env.LDAP_TLS_INSECURE_EXCEPTION_EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();
  const result = ldapTlsPolicy({ encryption: "ldaps", skipVerify: true });
  assert.equal(result.allowed, true);
  assert.match(result.warning ?? "", /Temporary insecure LDAP exception/);
  process.env.LDAP_TLS_INSECURE_EXCEPTION_EXPIRES_AT = new Date(Date.now() - 60_000).toISOString();
  assert.equal(ldapTlsPolicy({ encryption: "plain", skipVerify: false }).allowed, false);
});