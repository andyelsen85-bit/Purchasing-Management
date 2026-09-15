import assert from "node:assert/strict";
import test from "node:test";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createBackupEncryptionStream,
  decryptBackup,
  decryptBackupFile,
  encryptBackup,
  isEncryptedBackup,
} from "./backup-crypto";

test("backup envelope round-trips with a random per-export salt and nonce", () => {
  const payload = JSON.stringify({ version: 1, tables: { users: [{ id: 1 }] } });
  const first = encryptBackup(payload, "correct horse battery staple");
  const second = encryptBackup(payload, "correct horse battery staple");
  assert.equal(isEncryptedBackup(first), true);
  assert.notDeepEqual(first, second);
  assert.equal(decryptBackup(first, "correct horse battery staple"), payload);
});

test("backup envelope rejects tampering and wrong passphrases without redaction leaks", () => {
  const encrypted = encryptBackup("sensitive row", "correct horse battery staple");
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 20] ^= 1;
  assert.throws(() => decryptBackup(tampered, "correct horse battery staple"), /could not be decrypted/);
  assert.throws(() => decryptBackup(encrypted, "wrong passphrase"), /could not be decrypted/);
});

test("backup passphrases must not be trivially short", () => {
  assert.throws(() => encryptBackup("{}", "short"), /12 characters/);
});

test("backup restore decryption can stream to disk", async () => {
  const input = path.join(tmpdir(), `investflow-backup-${process.pid}.backup`);
  const output = `${input}.json`;
  await fsp.writeFile(input, encryptBackup(JSON.stringify({ rows: [1, 2, 3] }), "correct horse battery staple"));
  try {
    await decryptBackupFile(input, output, "correct horse battery staple");
    assert.equal(await fsp.readFile(output, "utf8"), JSON.stringify({ rows: [1, 2, 3] }));
  } finally {
    await fsp.unlink(input).catch(() => {});
    await fsp.unlink(output).catch(() => {});
  }
});

test("backup export encryption is a streaming transform", async () => {
  const chunks: Buffer[] = [];
  const encrypted = createBackupEncryptionStream("correct horse battery staple");
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await pipeline(
    Readable.from(["{\"tables\":", "{}", "}"]),
    encrypted,
    sink,
  );
  const bytes = Buffer.concat(chunks);
  assert.equal(decryptBackup(bytes, "correct horse battery staple"), "{\"tables\":{}}");
});

test("streaming restore enforces an output size limit", async () => {
  const input = path.join(tmpdir(), `investflow-backup-limit-${process.pid}.backup`);
  const output = `${input}.json`;
  await fsp.writeFile(input, encryptBackup("0123456789", "correct horse battery staple"));
  try {
    await assert.rejects(
      decryptBackupFile(input, output, "correct horse battery staple", 4),
      /could not be decrypted/,
    );
  } finally {
    await fsp.unlink(input).catch(() => {});
    await fsp.unlink(output).catch(() => {});
  }
});