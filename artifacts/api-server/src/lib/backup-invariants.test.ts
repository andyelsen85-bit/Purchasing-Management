import assert from "node:assert/strict";
import test from "node:test";
import { getTableName, isTable } from "drizzle-orm";
import * as schema from "@workspace/db/schema";
import {
  backupJsonChunks,
  SESSION_TABLE_NAME,
  TABLES,
  withBackupSnapshot,
} from "../routes/backup";
import { decryptBackup, encryptBackup } from "./backup-crypto";

test("backup inventory includes all persisted domain tables and never exports sessions", () => {
  const names = TABLES.map((table) => table.name as string);
  const intentionallyExcludedOperationalTables = new Set([
    // Transient connect-pg-simple session stores are cleared, never exported.
    SESSION_TABLE_NAME,
    "sessions",
  ]);
  const schemaNames = Object.values(schema)
    .filter(isTable)
    .map(getTableName);
  const expectedBackupNames = schemaNames.filter(
    (name) => !intentionallyExcludedOperationalTables.has(name),
  );

  assert.equal(SESSION_TABLE_NAME, "session");
  assert.equal(names.includes("session"), false);
  assert.equal(names.includes("sessions"), false);
  assert.equal(new Set(names).size, names.length, "backup inventory has duplicate tables");
  assert.equal(
    new Set(schemaNames).size,
    schemaNames.length,
    "schema exports duplicate table declarations",
  );
  assert.deepEqual(
    [...names].sort(),
    [...expectedBackupNames].sort(),
    "every persisted domain table must be covered by backup/restore",
  );
});

test("backup snapshot wrapper sets repeatable-read and rolls back errors", async () => {
  const events: string[] = [];
  const database = {
    async transaction(callback: (tx: any) => Promise<unknown>) {
      events.push("begin");
      try {
        const value = await callback({ execute: async () => events.push("repeatable-read") });
        events.push("commit");
        return value;
      } catch (error) {
        events.push("rollback");
        throw error;
      }
    },
  };
  await withBackupSnapshot(database as any, async () => "ok");
  assert.deepEqual(events, ["begin", "repeatable-read", "commit"]);
  await assert.rejects(
    withBackupSnapshot(database as any, async () => {
      throw new Error("stream failed");
    }),
    /stream failed/,
  );
  assert.deepEqual(events.slice(-2), ["repeatable-read", "rollback"]);
});

test("mocked export has stable ordering and decrypts to a complete inventory", async () => {
  const orderCalls: number[] = [];
  const executor = {
    select() {
      const query = {
        from() {
          return query;
        },
        orderBy(...columns: unknown[]) {
          orderCalls.push(columns.length);
          return query;
        },
        limit() {
          return query;
        },
        async offset() {
          return [];
        },
      };
      return query;
    },
  };
  let plaintext = "";
  for await (const chunk of backupJsonChunks("test-admin", executor as any)) {
    plaintext += chunk;
  }
  const payload = JSON.parse(decryptBackup(encryptBackup(plaintext, "correct horse battery staple"), "correct horse battery staple"));
  assert.deepEqual(Object.keys(payload.tables), TABLES.map((table) => table.name));
  assert.equal(orderCalls.length, TABLES.length);
  assert.ok(orderCalls.every((count) => count > 0));
});