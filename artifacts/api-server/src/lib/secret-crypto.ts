import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Settings secrets use a deterministic compatibility key so this deployment
 * does not require an operator-managed encryption key. This prevents plaintext
 * storage but is not protection against an attacker who has both the database
 * and application image.
 */
export type SecretContext = "smtp.password" | "ldap.bindPassword" | "adfs.clientSecret";
const VERSION = "scv2";
const LEGACY_VERSION = "scv1";
const KEY_BYTES = 32;
const AAD_PREFIX = "investflow/settings/";
const COMPATIBILITY_KEY = createHash("sha256")
  .update("investflow-embedded-settings-compatibility-key", "utf8")
  .digest();

export class SecretCryptoError extends Error {
  readonly code: "invalid-ciphertext";
  constructor(code: SecretCryptoError["code"]) {
    super("Stored setting secret could not be decrypted");
    this.name = "SecretCryptoError";
    this.code = code;
  }
}

function compatibilityKey(): Buffer {
  return COMPATIBILITY_KEY;
}

function parseLegacyKey(raw: string | undefined): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === KEY_BYTES ? decoded : null;
  } catch {
    return null;
  }
}

function legacyKey(): Buffer | null {
  const environmentKey = parseLegacyKey(process.env.SETTINGS_ENCRYPTION_KEY);
  if (environmentKey) return environmentKey;
  const file = process.env.SETTINGS_ENCRYPTION_KEY_FILE ?? "/app/state/settings_encryption_key";
  try {
    return parseLegacyKey(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function aad(context: SecretContext, version = VERSION): Buffer {
  return Buffer.from(`${AAD_PREFIX}${context}/${version}`, "utf8");
}

function decodePart(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/** Encrypt a setting secret using an authenticated, versioned envelope. */
export function encryptSettingSecret(value: string, context: SecretContext): string {
  if (typeof value !== "string") throw new SecretCryptoError("invalid-ciphertext");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", compatibilityKey(), nonce);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [VERSION, nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Decrypt a current envelope. Errors intentionally never include ciphertext or plaintext. */
export function decryptSettingSecret(encoded: string, context: SecretContext): string {
  try {
    const parts = encoded.split(".");
    const version = parts[0];
    if (parts.length !== 4 || (version !== VERSION && version !== LEGACY_VERSION)) {
      throw new Error("format");
    }
    const nonce = decodePart(parts[1]!);
    const tag = decodePart(parts[2]!);
    const ciphertext = decodePart(parts[3]!);
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error("format");
    const key = version === VERSION ? compatibilityKey() : legacyKey();
    if (!key) throw new Error("legacy-key-unavailable");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad(context, version));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof SecretCryptoError) throw error;
    throw new SecretCryptoError("invalid-ciphertext");
  }
}

export function isSettingSecretEnvelope(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value.startsWith(`${VERSION}.`) || value.startsWith(`${LEGACY_VERSION}.`))
  );
}

/**
 * Read a value while identifying legacy plaintext for migration.
 */
export function readSettingSecret(
  value: string | null | undefined,
  context: SecretContext,
): { value: string | null; legacy: boolean } {
  if (value == null || value === "") return { value: null, legacy: false };
  if (value.startsWith(`${VERSION}.`)) {
    return { value: decryptSettingSecret(value, context), legacy: false };
  }
  if (value.startsWith(`${LEGACY_VERSION}.`)) {
    try {
      return { value: decryptSettingSecret(value, context), legacy: true };
    } catch {
      // A previous operator key cannot be reconstructed. Keep the ciphertext
      // in storage, start normally, and let an administrator enter the value
      // again instead of aborting the entire application.
      return { value: null, legacy: false };
    }
  }
  return { value, legacy: true };
}

/** Re-encrypt a legacy value (or normalize a current value) without logging it. */
export function migrateSettingSecret(
  value: string,
  context: SecretContext,
): string {
  const read = readSettingSecret(value, context);
  if (read.value == null) throw new SecretCryptoError("invalid-ciphertext");
  return encryptSettingSecret(read.value, context);
}

// Short aliases kept for callers that use the generic crypto terminology.
export const encryptSecret = encryptSettingSecret;
export const decryptSecret = decryptSettingSecret;
export const migrateSecret = migrateSettingSecret;

// Exported for backup envelope tests and the backup route.
export const SETTINGS_CRYPTO_VERSION = VERSION;
export function deriveBackupKey(passphrase: string, salt: Buffer): Buffer {
  if (!passphrase || passphrase.length < 12) throw new Error("Backup passphrase must be at least 12 characters");
  return scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}