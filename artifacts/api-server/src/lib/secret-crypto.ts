import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Current settings secrets use an operator-managed key. The embedded scv2 key
 * remains only to decrypt and migrate values written by version 1.3.0.
 */
export type SecretContext = "smtp.password" | "ldap.bindPassword" | "adfs.clientSecret";
const VERSION = "scv3";
const EMBEDDED_VERSION = "scv2";
const LEGACY_VERSION = "scv1";
const KEY_BYTES = 32;
const AAD_PREFIX = "investflow/settings/";
const COMPATIBILITY_KEY = createHash("sha256")
  .update("investflow-embedded-settings-compatibility-key", "utf8")
  .digest();

export class SecretCryptoError extends Error {
  readonly code: "missing-key" | "invalid-key" | "invalid-ciphertext";
  constructor(code: SecretCryptoError["code"]) {
    super(
      code === "missing-key"
        ? "Settings encryption key is not configured"
        : code === "invalid-key"
          ? "Settings encryption key is invalid"
          : "Stored setting secret could not be decrypted",
    );
    this.name = "SecretCryptoError";
    this.code = code;
  }
}

function embeddedCompatibilityKey(): Buffer {
  return COMPATIBILITY_KEY;
}

function parseKey(raw: string | undefined): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  const unpadded =
    /^[A-Za-z0-9+/_-]{43}$/.test(value)
      ? value
      : /^[A-Za-z0-9+/_-]{43}=$/.test(value)
        ? value.slice(0, -1)
        : null;
  if (!unpadded) return null;
  // Do not allow a single value to mix the standard and URL-safe alphabets.
  if ((/[+/]/.test(unpadded) && /[-_]/.test(unpadded))) return null;
  const decoded = Buffer.from(unpadded, "base64url");
  const normalized = unpadded.replace(/\+/g, "-").replace(/\//g, "_");
  return decoded.length === KEY_BYTES && decoded.toString("base64url") === normalized
    ? decoded
    : null;
}

function production(): boolean {
  return process.env.NODE_ENV === "production";
}

function keyFromEnvironment(): Buffer {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY?.trim();
  if (!raw) {
    if (production()) throw new SecretCryptoError("missing-key");
    return createHash("sha256")
      .update("investflow-development-settings-encryption-key", "utf8")
      .digest();
  }
  const key = parseKey(raw);
  if (!key) throw new SecretCryptoError("invalid-key");
  const sessionRaw = process.env.SESSION_SECRET?.trim();
  const sessionKey = parseKey(sessionRaw);
  if (sessionRaw && (raw === sessionRaw || sessionKey?.equals(key))) {
    throw new SecretCryptoError("invalid-key");
  }
  return key;
}

function legacyKeys(): Buffer[] {
  const keys: Buffer[] = [];
  const environmentKey = parseKey(process.env.SETTINGS_ENCRYPTION_KEY);
  if (environmentKey) keys.push(environmentKey);
  const file = process.env.SETTINGS_ENCRYPTION_KEY_FILE ?? "/app/state/settings_encryption_key";
  try {
    const fileKey = parseKey(readFileSync(file, "utf8"));
    if (fileKey && !keys.some((key) => key.equals(fileKey))) keys.push(fileKey);
  } catch {
    // A persisted key file exists only on installations that generated one.
  }
  return keys;
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
  const cipher = createCipheriv("aes-256-gcm", keyFromEnvironment(), nonce);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [VERSION, nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Decrypt a current envelope. Errors intentionally never include ciphertext or plaintext. */
export function decryptSettingSecret(encoded: string, context: SecretContext): string {
  try {
    const parts = encoded.split(".");
    const version = parts[0];
    if (
      parts.length !== 4 ||
      (version !== VERSION && version !== EMBEDDED_VERSION && version !== LEGACY_VERSION)
    ) {
      throw new Error("format");
    }
    const nonce = decodePart(parts[1]!);
    const tag = decodePart(parts[2]!);
    const ciphertext = decodePart(parts[3]!);
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error("format");
    const keys =
      version === VERSION
        ? [keyFromEnvironment()]
        : version === EMBEDDED_VERSION
          ? [embeddedCompatibilityKey()]
          : legacyKeys();
    for (const key of keys) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(aad(context, version));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch {
        // Try the next historical key source without exposing secret material.
      }
    }
    throw new Error("key-unavailable-or-invalid");
  } catch (error) {
    if (error instanceof SecretCryptoError) throw error;
    throw new SecretCryptoError("invalid-ciphertext");
  }
}

export function isSettingSecretEnvelope(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value.startsWith(`${VERSION}.`) ||
      value.startsWith(`${EMBEDDED_VERSION}.`) ||
      value.startsWith(`${LEGACY_VERSION}.`))
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
  if (
    value.startsWith(`${EMBEDDED_VERSION}.`) ||
    value.startsWith(`${LEGACY_VERSION}.`)
  ) {
    return { value: decryptSettingSecret(value, context), legacy: true };
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

/** Fail before the production API listener starts if its independent key is unavailable. */
export function assertSettingsEncryptionKey(): void {
  if (production()) keyFromEnvironment();
}

// Exported for backup envelope tests and the backup route.
export const SETTINGS_CRYPTO_VERSION = VERSION;
export function deriveBackupKey(passphrase: string, salt: Buffer): Buffer {
  if (!passphrase || passphrase.length < 12) throw new Error("Backup passphrase must be at least 12 characters");
  return scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}