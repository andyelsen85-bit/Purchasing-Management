import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";

/**
 * Settings secrets deliberately use a key which is unrelated to SESSION_SECRET.
 * Accepted operator formats are exactly 64 hexadecimal characters or a
 * base64/base64url encoding of 32 bytes.  A development-only in-memory-safe
 * fallback is used when NODE_ENV is not production; it never stores plaintext.
 */
export type SecretContext = "smtp.password" | "ldap.bindPassword" | "adfs.clientSecret";
const VERSION = "scv1";
const KEY_BYTES = 32;
const AAD_PREFIX = "investflow/settings/";

export class SecretCryptoError extends Error {
  readonly code: "missing-key" | "invalid-key" | "invalid-ciphertext";
  constructor(code: SecretCryptoError["code"]) {
    super(
      code === "missing-key"
        ? "Settings encryption key is not configured"
        : code === "invalid-key"
          ? "Settings encryption key has an invalid format"
          : "Stored setting secret could not be decrypted",
    );
    this.name = "SecretCryptoError";
    this.code = code;
  }
}

function production(): boolean {
  return process.env.NODE_ENV === "production";
}

function keyFromEnvironment(): Buffer {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY?.trim();
  if (!raw) {
    if (production()) throw new SecretCryptoError("missing-key");
    // Development must remain usable, but this is still encrypted and is
    // intentionally not derived from SESSION_SECRET.
    return createHash("sha256")
      .update("investflow-development-settings-encryption-key", "utf8")
      .digest();
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  try {
    const decoded = Buffer.from(raw, "base64url");
    if (decoded.length === KEY_BYTES) return decoded;
  } catch {
    /* handled by the common error below */
  }
  throw new SecretCryptoError("invalid-key");
}

/** Fail during module initialization in production, before any listener starts. */
export function assertSettingsEncryptionKey(): void {
  if (production()) keyFromEnvironment();
}

function aad(context: SecretContext): Buffer {
  return Buffer.from(`${AAD_PREFIX}${context}/${VERSION}`, "utf8");
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
    if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("format");
    const nonce = decodePart(parts[1]!);
    const tag = decodePart(parts[2]!);
    const ciphertext = decodePart(parts[3]!);
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error("format");
    const decipher = createDecipheriv("aes-256-gcm", keyFromEnvironment(), nonce);
    decipher.setAAD(aad(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof SecretCryptoError) throw error;
    throw new SecretCryptoError("invalid-ciphertext");
  }
}

export function isSettingSecretEnvelope(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(`${VERSION}.`);
}

/**
 * Read a value while identifying legacy plaintext. Legacy values are accepted
 * for migration only; production refuses to expose them without a key.
 */
export function readSettingSecret(
  value: string | null | undefined,
  context: SecretContext,
): { value: string | null; legacy: boolean } {
  if (value == null || value === "") return { value: null, legacy: false };
  if (isSettingSecretEnvelope(value)) return { value: decryptSettingSecret(value, context), legacy: false };
  if (production() && !process.env.SETTINGS_ENCRYPTION_KEY?.trim()) {
    throw new SecretCryptoError("missing-key");
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