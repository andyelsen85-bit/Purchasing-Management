import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptSettingSecret,
  encryptSettingSecret,
  migrateSettingSecret,
  readSettingSecret,
} from "./secret-crypto";

const originalEnv = process.env.SETTINGS_ENCRYPTION_KEY;
const originalNodeEnv = process.env.NODE_ENV;

test.afterEach(() => {
  if (originalEnv === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
  else process.env.SETTINGS_ENCRYPTION_KEY = originalEnv;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

test("settings secrets round-trip and bind to authenticated context", () => {
  process.env.SETTINGS_ENCRYPTION_KEY = "11".repeat(32);
  const encoded = encryptSettingSecret("smtp-password", "smtp.password");
  assert.equal(decryptSettingSecret(encoded, "smtp.password"), "smtp-password");
  assert.throws(() => decryptSettingSecret(`${encoded}x`, "smtp.password"), /could not be decrypted/);
  assert.throws(() => decryptSettingSecret(encoded, "ldap.bindPassword"), /could not be decrypted/);
});

test("wrong key and redaction never expose secret material", () => {
  process.env.SETTINGS_ENCRYPTION_KEY = "22".repeat(32);
  const encoded = encryptSettingSecret("do-not-log-this", "ldap.bindPassword");
  process.env.SETTINGS_ENCRYPTION_KEY = "33".repeat(32);
  assert.throws(
    () => decryptSettingSecret(encoded, "ldap.bindPassword"),
    (err: Error) => !err.message.includes("do-not-log-this") && !err.message.includes(encoded),
  );
});

test("legacy plaintext is readable for migration and replacement is encrypted", () => {
  delete process.env.SETTINGS_ENCRYPTION_KEY;
  delete process.env.NODE_ENV;
  assert.deepEqual(readSettingSecret("legacy-value", "smtp.password"), {
    value: "legacy-value",
    legacy: true,
  });
  process.env.SETTINGS_ENCRYPTION_KEY = "44".repeat(32);
  const migrated = migrateSettingSecret("legacy-value", "smtp.password");
  assert.equal(decryptSettingSecret(migrated, "smtp.password"), "legacy-value");
  const cleared = readSettingSecret(null, "smtp.password");
  assert.deepEqual(cleared, { value: null, legacy: false });
});

test("production fails closed without the independent key", () => {
  process.env.NODE_ENV = "production";
  delete process.env.SETTINGS_ENCRYPTION_KEY;
  assert.throws(() => encryptSettingSecret("secret", "smtp.password"), /not configured/);
  assert.throws(() => readSettingSecret("legacy", "smtp.password"), /not configured/);
});