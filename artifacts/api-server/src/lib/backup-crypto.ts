import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

const MAGIC = Buffer.from("IFBK", "ascii");
const VERSION = 1;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from("investflow/backup/v1", "ascii");
const MIN_PASSPHRASE_LENGTH = 12;
const SCRYPT_OPTIONS = {
  N: 1 << 15,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
// AES-GCM preserves payload length; the envelope adds magic/version/salt/
// nonce/tag bytes. Keep plaintext below the restore ceiling so every export
// produced by this service is accepted by restore.
export const MAX_BACKUP_PLAINTEXT_BYTES =
  MAX_BACKUP_BYTES - (4 + 1 + 16 + 12 + 16);
type GcmDecipher = ReturnType<typeof createDecipheriv> & {
  setAAD(aad: Buffer): unknown;
  setAuthTag(tag: Buffer): unknown;
};

function key(passphrase: string, salt: Buffer): Buffer {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error("Backup passphrase must be at least 12 characters");
  }
  return scryptSync(passphrase, salt, 32, SCRYPT_OPTIONS);
}

/** Encrypt a complete JSON backup into a compact authenticated binary envelope. */
export function encryptBackup(payload: string, passphrase: string): Buffer {
  if (Buffer.byteLength(payload, "utf8") > MAX_BACKUP_PLAINTEXT_BYTES) {
    throw new Error("Backup exceeds the 512 MiB export limit");
  }
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(passphrase, salt), nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, nonce, ciphertext, cipher.getAuthTag()]);
}

/** Create a backpressure-aware envelope transform for large exports. */
export function createBackupEncryptionStream(passphrase: string): Transform {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(passphrase, salt), nonce);
  cipher.setAAD(AAD);
  let headerSent = false;
  let plaintextBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        plaintextBytes += chunk.byteLength;
        if (plaintextBytes > MAX_BACKUP_PLAINTEXT_BYTES) {
          callback(new Error("Backup exceeds the 512 MiB export limit"));
          return;
        }
        if (!headerSent) {
          this.push(Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, nonce]));
          headerSent = true;
        }
        this.push(cipher.update(chunk));
        callback();
      } catch {
        callback(new Error("Backup encryption failed"));
      }
    },
    flush(callback) {
      try {
        this.push(cipher.final());
        this.push(cipher.getAuthTag());
        callback();
      } catch {
        callback(new Error("Backup encryption failed"));
      }
    },
  });
}

export function isEncryptedBackup(data: Buffer): boolean {
  return data.length >= MAGIC.length + 1 + SALT_BYTES + NONCE_BYTES + TAG_BYTES &&
    data.subarray(0, MAGIC.length).equals(MAGIC) &&
    data[MAGIC.length] === VERSION;
}

/** Decrypt and authenticate a backup. Authentication failures are redacted. */
export function decryptBackup(data: Buffer, passphrase: string): string {
  try {
    if (!isEncryptedBackup(data)) throw new Error("format");
    const headerLength = MAGIC.length + 1 + SALT_BYTES + NONCE_BYTES;
    const salt = data.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_BYTES);
    const nonce = data.subarray(MAGIC.length + 1 + SALT_BYTES, headerLength);
    const tag = data.subarray(data.length - TAG_BYTES);
    const ciphertext = data.subarray(headerLength, data.length - TAG_BYTES);
    if (ciphertext.length === 0) throw new Error("format");
    const decipher = createDecipheriv("aes-256-gcm", key(passphrase, salt), nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof Error && error.message === "Backup passphrase must be at least 12 characters") {
      throw error;
    }
    throw new Error("Backup could not be decrypted (wrong passphrase or corrupted file)");
  }
}

/**
 * Stream an envelope to a plaintext file while retaining only the GCM tag
 * (the final 16 bytes) between chunks. This keeps restore memory bounded by
 * stream backpressure rather than the size of document blobs.
 */
export async function decryptBackupFile(
  inputPath: string,
  outputPath: string,
  passphrase: string,
  maxOutputBytes = MAX_BACKUP_BYTES,
): Promise<void> {
  let header = Buffer.alloc(0);
  let decipher: GcmDecipher | null = null;
  let tail = Buffer.alloc(0);
  let outputBytes = 0;
  let failed = false;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        let data = Buffer.concat([header, chunk]);
        if (!decipher) {
          if (data.length < MAGIC.length + 1 + SALT_BYTES + NONCE_BYTES) {
            header = data;
            callback();
            return;
          }
          const headerLength = MAGIC.length + 1 + SALT_BYTES + NONCE_BYTES;
          const envelopeHeader = data.subarray(0, headerLength);
          if (
            !envelopeHeader.subarray(0, MAGIC.length).equals(MAGIC) ||
            envelopeHeader[MAGIC.length] !== VERSION
          ) throw new Error("format");
          const salt = envelopeHeader.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_BYTES);
          const nonce = envelopeHeader.subarray(MAGIC.length + 1 + SALT_BYTES, headerLength);
          decipher = createDecipheriv("aes-256-gcm", key(passphrase, salt), nonce) as GcmDecipher;
          decipher.setAAD(AAD);
          data = data.subarray(headerLength);
        }
        const combined = Buffer.concat([tail, data]);
        if (combined.length > TAG_BYTES) {
          const body = combined.subarray(0, combined.length - TAG_BYTES);
          tail = combined.subarray(combined.length - TAG_BYTES);
          const plaintext = decipher!.update(body);
          outputBytes += plaintext.length;
          if (outputBytes > maxOutputBytes) throw new Error("size");
          this.push(plaintext);
        } else {
          tail = combined;
        }
        header = Buffer.alloc(0);
        callback();
      } catch {
        failed = true;
        callback(new Error("Backup could not be decrypted (wrong passphrase or corrupted file)"));
      }
    },
    flush(callback) {
      try {
        if (failed || !decipher || tail.length !== TAG_BYTES) throw new Error("format");
        decipher.setAuthTag(tail);
        const plaintext = decipher.final();
        outputBytes += plaintext.length;
        if (outputBytes > maxOutputBytes) throw new Error("size");
        this.push(plaintext);
        callback();
      } catch {
        callback(new Error("Backup could not be decrypted (wrong passphrase or corrupted file)"));
      }
    },
  });
  try {
    await pipeline(createReadStream(inputPath), transform, createWriteStream(outputPath, { mode: 0o600 }));
  } catch (error) {
    if (error instanceof Error && error.message === "Backup passphrase must be at least 12 characters") {
      throw error;
    }
    throw new Error("Backup could not be decrypted (wrong passphrase or corrupted file)");
  }
}

export const BACKUP_ENVELOPE_VERSION = VERSION;