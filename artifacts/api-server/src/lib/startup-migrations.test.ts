import assert from "node:assert/strict";
import test from "node:test";
import { migrateSettingsData } from "./startup-migrations";
import { decryptSettingSecret } from "./secret-crypto";

const originalSettingsKey = process.env.SETTINGS_ENCRYPTION_KEY;

test.beforeEach(() => {
  process.env.SETTINGS_ENCRYPTION_KEY = "aa".repeat(32);
});

test.afterEach(() => {
  if (originalSettingsKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
  else process.env.SETTINGS_ENCRYPTION_KEY = originalSettingsKey;
});

test("startup settings migration encrypts legacy secrets and preserves null precedence", () => {
  process.env.NODE_ENV = "development";
  const result = migrateSettingsData({
    appName: "InvestFlow",
    ldap: { bindPassword: "legacy-ldap" },
    smtp: { password: "legacy-smtp" },
    adfs: { clientSecretEncrypted: null },
  });
  assert.equal(result.migrated, 2);
  assert.equal(
    decryptSettingSecret(result.data.ldap!.bindPassword!, "ldap.bindPassword"),
    "legacy-ldap",
  );
  assert.equal(
    decryptSettingSecret(result.data.smtp!.password!, "smtp.password"),
    "legacy-smtp",
  );
  assert.equal(result.data.adfs!.clientSecretEncrypted, null);
});