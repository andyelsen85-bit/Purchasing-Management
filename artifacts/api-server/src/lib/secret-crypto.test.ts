import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertSettingsEncryptionKey,
  decryptSettingSecret,
  encryptSettingSecret,
  migrateSettingSecret,
  readSettingSecret,
} from "./secret-crypto";

const originalSettingsKey = process.env.SETTINGS_ENCRYPTION_KEY;
const originalSettingsKeyFile = process.env.SETTINGS_ENCRYPTION_KEY_FILE;
const originalSessionSecret = process.env.SESSION_SECRET;
const originalNodeEnv = process.env.NODE_ENV;

test.beforeEach(() => {
  process.env.NODE_ENV = "development";
  process.env.SETTINGS_ENCRYPTION_KEY = "44".repeat(32);
  process.env.SESSION_SECRET = "session-secret-that-is-distinct-and-at-least-32-characters";
  delete process.env.SETTINGS_ENCRYPTION_KEY_FILE;
});

test.afterEach(() => {
  if (originalSettingsKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
  else process.env.SETTINGS_ENCRYPTION_KEY = originalSettingsKey;
  if (originalSettingsKeyFile === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY_FILE;
  else process.env.SETTINGS_ENCRYPTION_KEY_FILE = originalSettingsKeyFile;
  if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSessionSecret;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

function envelope(value: string, context: string, key: Buffer, version: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`investflow/settings/${context}/${version}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    version,
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

test("settings secrets round-trip and bind to authenticated context", () => {
  const encoded = encryptSettingSecret("smtp-password", "smtp.password");
  assert.match(encoded, /^scv3\./);
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
  assert.deepEqual(readSettingSecret("legacy-value", "smtp.password"), {
    value: "legacy-value",
    legacy: true,
  });
  const migrated = migrateSettingSecret("legacy-value", "smtp.password");
  assert.equal(decryptSettingSecret(migrated, "smtp.password"), "legacy-value");
  const cleared = readSettingSecret(null, "smtp.password");
  assert.deepEqual(cleared, { value: null, legacy: false });
});

test("production requires a valid operator-managed settings key", () => {
  process.env.NODE_ENV = "production";
  delete process.env.SETTINGS_ENCRYPTION_KEY;
  assert.throws(() => assertSettingsEncryptionKey(), /not configured/);
  assert.throws(() => encryptSettingSecret("secret", "smtp.password"), /not configured/);

  process.env.SETTINGS_ENCRYPTION_KEY = "too-short";
  assert.throws(() => assertSettingsEncryptionKey(), /invalid/);

  process.env.SETTINGS_ENCRYPTION_KEY = "55".repeat(32);
  assert.doesNotThrow(() => assertSettingsEncryptionKey());
  process.env.SESSION_SECRET = process.env.SETTINGS_ENCRYPTION_KEY;
  assert.throws(() => assertSettingsEncryptionKey(), /invalid/);
  process.env.SESSION_SECRET = "different-session-secret-that-is-at-least-32-characters";
  const encrypted = encryptSettingSecret("secret", "smtp.password");
  assert.equal(decryptSettingSecret(encrypted, "smtp.password"), "secret");
});

test("production accepts only canonical 32-byte base64 key encodings", () => {
  process.env.NODE_ENV = "production";
  const bytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  const standardPadded = bytes.toString("base64");
  const standardUnpadded = standardPadded.replace(/=$/, "");
  const urlUnpadded = bytes.toString("base64url");
  for (const value of [
    standardPadded,
    standardUnpadded,
    urlUnpadded,
    `${urlUnpadded}=`,
  ]) {
    process.env.SETTINGS_ENCRYPTION_KEY = value;
    assert.doesNotThrow(() => assertSettingsEncryptionKey());
  }
  for (const value of [
    `${urlUnpadded}!`,
    `${urlUnpadded.slice(0, 10)}!${urlUnpadded.slice(11)}`,
    `${urlUnpadded}==`,
    `${urlUnpadded.slice(0, 42)}B`,
  ]) {
    process.env.SETTINGS_ENCRYPTION_KEY = value;
    assert.throws(() => assertSettingsEncryptionKey(), /invalid/);
  }
});

test("embedded scv2 values migrate to operator-managed scv3", () => {
  const embeddedKey = createHash("sha256")
    .update("investflow-embedded-settings-compatibility-key", "utf8")
    .digest();
  const embedded = envelope("compatibility-secret", "adfs.clientSecret", embeddedKey, "scv2");
  assert.deepEqual(readSettingSecret(embedded, "adfs.clientSecret"), {
    value: "compatibility-secret",
    legacy: true,
  });
  const migrated = migrateSettingSecret(embedded, "adfs.clientSecret");
  assert.match(migrated, /^scv3\./);
  assert.equal(decryptSettingSecret(migrated, "adfs.clientSecret"), "compatibility-secret");
});

test("legacy scv1 values migrate when the former environment key is available", () => {
  const key = "66".repeat(32);
  process.env.SETTINGS_ENCRYPTION_KEY = key;
  const legacy = envelope("old-secret", "smtp.password", Buffer.from(key, "hex"), "scv1");
  assert.deepEqual(readSettingSecret(legacy, "smtp.password"), {
    value: "old-secret",
    legacy: true,
  });
  const migrated = migrateSettingSecret(legacy, "smtp.password");
  assert.match(migrated, /^scv3\./);
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
    const legacy = envelope(
      "file-secret",
      "ldap.bindPassword",
      Buffer.from(key, "hex"),
      "scv1",
    );
    assert.deepEqual(readSettingSecret(legacy, "ldap.bindPassword"), {
      value: "file-secret",
      legacy: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unrecoverable legacy scv1 values fail closed without exposing material", () => {
  delete process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY_FILE = "/nonexistent/settings-key";
  const legacy = envelope(
    "unavailable",
    "adfs.clientSecret",
    Buffer.from("88".repeat(32), "hex"),
    "scv1",
  );
  assert.throws(
    () => readSettingSecret(legacy, "adfs.clientSecret"),
    (err: Error) => !err.message.includes("unavailable") && !err.message.includes(legacy),
  );
});