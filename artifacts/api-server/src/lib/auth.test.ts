import assert from "node:assert/strict";
import test from "node:test";
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  isDefaultBootstrapAdmin,
  passwordHashForVerification,
} from "./auth";

test("default bootstrap detection requires the literal admin password", async () => {
  const defaultHash = await hashPassword("admin");
  assert.equal(await isDefaultBootstrapAdmin("admin", "LOCAL", defaultHash), true);
  assert.equal(await isDefaultBootstrapAdmin("admin", "LDAP", defaultHash), false);
  assert.equal(await isDefaultBootstrapAdmin("admin", "LOCAL", await hashPassword("changed")), false);
  assert.equal(await isDefaultBootstrapAdmin("administrator", "LOCAL", defaultHash), false);
});

test("nonexistent password verification uses a valid fixed-shape dummy hash", () => {
  assert.equal(passwordHashForVerification(null), DUMMY_PASSWORD_HASH);
  const [salt, digest] = DUMMY_PASSWORD_HASH.split(":");
  assert.equal(salt.length, 32);
  assert.equal(digest.length, 128);
});