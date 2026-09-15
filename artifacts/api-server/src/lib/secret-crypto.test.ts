import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decryptSettingSecret,
  encryptSettingSecret,
  migrateSettingSecret,
  readSettingSecret,
} from "./secret-crypto";

const originalSettingsKey = process.env.SETTINGS_ENCRYPTION_KEY;
const originalSettingsKeyFile = process.env.SETTINGS_ENCRYPTION_KEY_FILE;
const originalNodeEnv = process.env.NODE_ENV;

test.afterEach(() => {
  if (originalSettingsKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
  else process.env.SETTINGS_ENCRYPTION_KEY = originalSettingsKey;
  if (originalSettingsKeyFile === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY_FILE;
  else process.env.SETTINGS_ENCRYPTION_KEY_FILE = originalSettingsKeyFile;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

function legacyEnvelope(value: string, context: string, keyHex: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), nonce);
  cipher.setAAD(Buffer.from(`investflow/settings/${context}/scv1`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "scv1",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

test("settings secrets round-trip and bind to authenticated context", () => {
  const encoded = encryptSettingSecret("smtp-password", "smtp.password");
  assert.match(encoded, /^scv2\./);
  assert.equal(decryptSettingSecret(encoded, "smtp.password"), "smtp-password");
  assert.throws(() => decryptSettingSecret(`${encoded}x`, "smtp.password"), /could not be decrypted/);
  assert.throws(() => decryptSettingSecret(encoded, "ldap.bindPassword"), /could not be decrypted/);
});

test("tampering and redaction never expose secret material", () => {
  const encoded = encryptSettingSecret("do-not-log-this", "ldap.bindPassword");
  const parts = encoded.split(".");
  const ciphertext = parts[3]!;
  parts[3] = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
  const tampered = parts.join(".");
  assert.throws(
    () => decryptSettingSecret(tampered, "ldap.bindPassword"),
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
  const migrated = migrateSettingSecret("legacy-value", "smtp.password");
  assert.equal(decryptSettingSecret(migrated, "smtp.password"), "legacy-value");
  const cleared = readSettingSecret(null, "smtp.password");
  assert.deepEqual(cleared, { value: null, legacy: false });
});

test("production works without an operator-managed settings key", () => {
  process.env.NODE_ENV = "production";
  delete process.env.SETTINGS_ENCRYPTION_KEY;
  const encrypted = encryptSettingSecret("secret", "smtp.password");
  assert.equal(decryptSettingSecret(encrypted, "smtp.password"), "secret");
  assert.deepEqual(readSettingSecret("legacy", "smtp.password"), {
    value: "legacy",
    legacy: true,
  });
});

test("legacy scv1 values migrate when the former environment key is available", () => {
  const key = "66".repeat(32);
  process.env.SETTINGS_ENCRYPTION_KEY = key;
  const legacy = legacyEnvelope("old-secret", "smtp.password", key);
  assert.deepEqual(readSettingSecret(legacy, "smtp.password"), {
    value: "old-secret",
    legacy: true,
  });
  const migrated = migrateSettingSecret(legacy, "smtp.password");
  assert.match(migrated, /^scv2\./);
  assert.equal(decryptSettingSecret(migrated, "smtp.password"), "old-secret");
});

test("legacy scv1 values can use the former persisted key file", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "settings-key-"));
  try {
    const key = "77".repeat(32);
    const keyFile = path.join(directory, "settings_encryption_key");
    writeFileSync(keyFile, key, { mode: 0o600 });
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    process.env.SETTINGS_ENCRYPTION_KEY_FILE = keyFile;
    const legacy = legacyEnvelope("file-secret", "ldap.bindPassword", key);
    assert.deepEqual(readSettingSecret(legacy, "ldap.bindPassword"), {
      value: "file-secret",
      legacy: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unrecoverable legacy scv1 values do not block no-key startup", () => {
  delete process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY_FILE = "/nonexistent/settings-key";
  const legacy = legacyEnvelope("unavailable", "adfs.clientSecret", "88".repeat(32));
  assert.deepEqual(readSettingSecret(legacy, "adfs.clientSecret"), {
    value: null,
    legacy: false,
  });
});