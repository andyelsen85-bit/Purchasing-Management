import assert from "node:assert/strict";
import test from "node:test";
import { migrateSettingsData } from "./startup-migrations";
import { decryptSettingSecret } from "./secret-crypto";

test("startup settings migration encrypts legacy secrets and preserves null precedence", () => {
  process.env.NODE_ENV = "development";
  process.env.SETTINGS_ENCRYPTION_KEY = "55".repeat(32);
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