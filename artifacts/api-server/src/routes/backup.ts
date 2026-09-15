import { Router, type IRouter } from "express";
import multer from "multer";
import { asc, sql } from "drizzle-orm";
import { createReadStream, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import pick from "stream-json/filters/pick.js";
import streamArray from "stream-json/streamers/stream-array.js";
import streamValues from "stream-json/streamers/stream-values.js";
import {
  db,
  usersTable,
  externalIdentityMappingsTable,
  departmentsTable,
  userDepartmentsTable,
  companiesTable,
  contactsTable,
  workflowsTable,
  documentsTable,
  documentVersionsTable,
  workflowStepsTable,
  notesTable,
  historyTable,
  auditLogTable,
  settingsTable,
  gtInvestDatesTable,
  gtInvestResultsTable,
  notificationsTable,
  notificationRulesTable,
  serviceSignaturesTable,
  tlsTable,
} from "@workspace/db";
import { requireAuth, requireRole, getUser } from "../middlewares/auth";
import { audit } from "../lib/audit";
import {
  decryptBackupFile,
  createBackupEncryptionStream,
  isEncryptedBackup,
  MAX_BACKUP_BYTES,
  MAX_BACKUP_PLAINTEXT_BYTES,
} from "../lib/backup-crypto";

const router: IRouter = Router();

// Tested bounded limit for encrypted input and decrypted JSON. Keeping this
// below 512 MiB leaves headroom for the streaming parser and database driver.
const MAX_RESTORE_BYTES = MAX_BACKUP_BYTES;
const RESTORE_TMP_DIR = path.join(tmpdir(), "purchasing-restore");
await fsp.mkdir(RESTORE_TMP_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: RESTORE_TMP_DIR }),
  limits: { fileSize: MAX_RESTORE_BYTES },
});

// Tables in FK-safe order: parents first when inserting, children first
// when truncating. We keep both lists explicit (rather than deriving)
// so a future schema change has to come back through this file.
export const SESSION_TABLE_NAME = "session";
export const TABLES = [
  { name: "users", t: usersTable, hasSerial: true, orderColumns: ["id"] },
  { name: "external_identity_mappings", t: externalIdentityMappingsTable, hasSerial: true, orderColumns: ["id"] },
  { name: "notification_rules", t: notificationRulesTable, hasSerial: true, orderColumns: ["id"] },
  { name: "departments", t: departmentsTable, hasSerial: true, orderColumns: ["id"] },
  { name: "user_departments", t: userDepartmentsTable, hasSerial: false, orderColumns: ["userId", "departmentId"] },
  { name: "companies", t: companiesTable, hasSerial: true, orderColumns: ["id"] },
  { name: "contacts", t: contactsTable, hasSerial: true, orderColumns: ["id"] },
  { name: "workflows", t: workflowsTable, hasSerial: true, orderColumns: ["id"] },
  { name: "service_signatures", t: serviceSignaturesTable, hasSerial: true, orderColumns: ["id"] },
  { name: "documents", t: documentsTable, hasSerial: true, orderColumns: ["id"] },
  { name: "document_versions", t: documentVersionsTable, hasSerial: true, orderColumns: ["id"] },
  { name: "workflow_steps", t: workflowStepsTable, hasSerial: true, orderColumns: ["id"] },
  { name: "notes", t: notesTable, hasSerial: true, orderColumns: ["id"] },
  { name: "history", t: historyTable, hasSerial: true, orderColumns: ["id"] },
  { name: "audit_log", t: auditLogTable, hasSerial: true, orderColumns: ["id"] },
  { name: "settings", t: settingsTable, hasSerial: true, orderColumns: ["id"] },
  { name: "gt_invest_dates", t: gtInvestDatesTable, hasSerial: true, orderColumns: ["id"] },
  { name: "gt_invest_results", t: gtInvestResultsTable, hasSerial: true, orderColumns: ["id"] },
  { name: "notifications", t: notificationsTable, hasSerial: true, orderColumns: ["id"] },
  { name: "tls_state", t: tlsTable, hasSerial: true, orderColumns: ["id"] },
] as const;

const TABLE_BY_NAME: Map<string, (typeof TABLES)[number]> = new Map(
  TABLES.map((x) => [x.name as string, x]),
);
const BACKUP_VERSION = 1;

// Postgres caps prepared-statement parameters at 65 535. Our widest
// tables have ~25 columns, so 1 000 rows per INSERT keeps us well
// inside that limit while still amortising round-trips.
const INSERT_BATCH_ROWS = 1000;
export const BACKUP_PAGE_ROWS = 500;

export type BackupExecutor = Pick<typeof db, "select">;
type BackupTransaction = BackupExecutor & {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
};
export type BackupTransactionDatabase = {
  transaction<T>(callback: (tx: BackupTransaction) => Promise<T>): Promise<T>;
};

/** Keep one coherent MVCC snapshot open for the complete streamed export. */
export function withBackupSnapshot<T>(
  database: BackupTransactionDatabase,
  work: (tx: BackupTransaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    return work(tx);
  });
}

/**
 * GET /api/admin/backup
 *
 * Streams every persisted table (except the transient `session` table) through
 * authenticated encryption. Rows are paged from Postgres so neither the
 * complete database nor the encrypted response is held in memory.
 */
router.get(
  "/admin/backup",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const passphrase = req.get("x-backup-passphrase");
    if (!passphrase) {
      res.status(400).json({ error: "An operator-supplied backup passphrase is required." });
      return;
    }
    const filename = `purchasing-backup-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename.replace(/\.json$/, ".backup")}"`,
    );
    await audit(getUser(req).id, "BACKUP", "system", undefined, filename, req.ip);
    // Never retain or log the passphrase. pipeline applies response
    // backpressure all the way through the paged DB generator and cipher.
    let source: Readable | null = null;
    const abortSource = () => source?.destroy(new Error("Backup client disconnected"));
    req.once("aborted", abortSource);
    res.once("close", () => {
      if (!res.writableEnded) abortSource();
    });
    try {
      await withBackupSnapshot(db, async (tx) => {
        source = Readable.from(backupJsonChunks(getUser(req).username, tx));
        await pipeline(source!, createBackupEncryptionStream(passphrase), res);
      });
    } catch (error) {
      // Once headers are sent, a partial encrypted envelope must be aborted;
      // it must never be reported as a successful backup.
      if (!res.headersSent) {
        res.status(500).json({ error: "Backup export failed." });
      } else if (!res.destroyed) {
        res.destroy(error instanceof Error ? error : new Error("Backup export failed"));
      }
    } finally {
      req.off("aborted", abortSource);
    }
  },
);

/**
 * POST /api/admin/restore
 *
 * Wipes every backed-up table and replays the rows from the uploaded
 * JSON dump inside a single transaction, so a failure mid-restore
 * leaves the previous data intact. Sequences are bumped to
 * `max(id) + 1` afterwards so newly created rows don't collide with
 * the restored IDs.
 *
 * The dump is decrypted to a mode-0600 temporary file and parsed row by row
 * with bounded insert batches. The tested encrypted input/plaintext limit is
 * 512 MiB; no larger capacity is implied by this endpoint.
 *
 * Sessions are explicitly NOT restored — every signed-in user is
 * forcibly logged out and must re-authenticate against the restored
 * user table. This is intentional: the admin who triggers the restore
 * may have been replaced by a different admin in the snapshot.
 */
router.post(
  "/admin/restore",
  requireAuth,
  requireRole("ADMIN"),
  upload.single("file"),
  async (req, res): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "No backup file uploaded." });
      return;
    }
    const filePath = req.file.path;
    let parsePath = filePath;
    let decryptedPath: string | null = null;
    const cleanup = async () => {
      await fsp.unlink(filePath).catch(() => {
        /* best-effort temp file cleanup */
      });
      if (decryptedPath) await fsp.unlink(decryptedPath).catch(() => {});
    };

    try {
      const passphrase =
        typeof req.body?.passphrase === "string" ? req.body.passphrase : "";
      if (req.file.size > MAX_RESTORE_BYTES) {
        res.status(413).json({ error: `Backup exceeds the ${MAX_RESTORE_BYTES} byte limit.` });
        await cleanup();
        return;
      }
      const prefix = await readFilePrefix(filePath, 64);
      const encrypted = isEncryptedBackup(prefix);
      if (encrypted) {
        if (!passphrase) {
          res.status(400).json({ error: "A backup passphrase is required." });
          await cleanup();
          return;
        }
        try {
          decryptedPath = `${filePath}.json`;
          await decryptBackupFile(filePath, decryptedPath, passphrase);
          parsePath = decryptedPath;
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
          await cleanup();
          return;
        }
      } else {
        const allowLegacy =
          process.env.NODE_ENV !== "production" ||
          (process.env.BACKUP_LEGACY_EXCEPTION_REASON?.trim() &&
            Number.isFinite(Date.parse(process.env.BACKUP_LEGACY_EXCEPTION_EXPIRES_AT ?? "")) &&
            Date.parse(process.env.BACKUP_LEGACY_EXCEPTION_EXPIRES_AT!) > Date.now());
        if (!allowLegacy) {
          res.status(400).json({
            error: "Plaintext backups are rejected in production; use an encrypted backup.",
          });
          await cleanup();
          return;
        }
        if (process.env.NODE_ENV === "production") {
          await audit(
            getUser(req).id,
            "LEGACY_BACKUP_RESTORE",
            "system",
            undefined,
            "time-boxed deployment exception",
            req.ip,
          );
        }
      }
      // ---- Pass 1: validate the version header before we touch the DB.
// Streams just the top-level `version` value out of the file and tears the
// parser down as soon as we have it.
      let version: number | undefined;
      try {
        version = await readTopLevelNumber(parsePath, "version");
      } catch (err) {
        res.status(400).json({
          error: `Backup is not valid JSON: ${(err as Error).message}`,
        });
        await cleanup();
        return;
      }
      if (version !== BACKUP_VERSION) {
        res.status(400).json({
          error: `Unrecognized backup format. Expected version ${BACKUP_VERSION}, got ${
            version ?? "missing"
          }.`,
        });
        await cleanup();
        return;
      }
      try {
        await preflightBackupTables(parsePath);
      } catch (err) {
        res.status(400).json({ error: `Backup preflight failed: ${(err as Error).message}` });
        await cleanup();
        return;
      }

      // ---- Pass 2: open transaction, truncate, and stream each table's
      // rows in bounded batches. Preflight has already authenticated the
      // complete table set before any destructive operation.
      const actor = getUser(req);
      let restored = 0;

      try {
        await db.transaction(async (tx) => {
          // CASCADE so child FKs (when present) follow; RESTART IDENTITY
          // so sequences zero out before we re-seed them.
          const all = TABLES.map((x) => `"${x.name}"`).join(", ");
          await tx.execute(
            sql.raw(`truncate ${all} restart identity cascade`),
          );
           // connect-pg-simple uses the singular `session` table. Clear it
           // in this same transaction so every pre-restore cookie is revoked.
           await tx.execute(sql.raw(`truncate "${SESSION_TABLE_NAME}"`));

          for (const meta of TABLES) {
            await streamTableRows(parsePath, meta.name, async (batch) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await tx.insert(meta.t as any).values(batch as any);
              restored += batch.length;
            });
          }

          // Bump every serial sequence past the largest restored id so
          // future inserts don't collide. Use the 3-arg form of setval
          // and pass `is_called=false` when the table is empty so that
          // the next nextval() returns 1 (rather than 2 with the 2-arg
          // form, which always sets is_called=true).
          for (const { name, hasSerial } of TABLES) {
            if (!hasSerial) continue;
            await tx.execute(
              sql.raw(
                `select setval(
                   pg_get_serial_sequence('"${name}"', 'id'),
                   greatest((select coalesce(max(id), 0) from "${name}"), 1),
                   (select count(*) > 0 from "${name}")
                 )`,
              ),
            );
          }
        });
      } catch (err) {
        req.log?.error({ err }, "restore failed");
        res
          .status(400)
          .json({ error: `Restore failed: ${(err as Error).message}` });
        await cleanup();
        return;
      }

      await audit(
        actor.id,
        "RESTORE",
        "system",
        undefined,
        `${restored} rows`,
        req.ip,
      );
      // Drop the caller's own session — the user table just got swapped
      // out from underneath them, so the session user record may no
      // longer be authoritative.
      req.session.destroy(() => {
        res.json({ ok: true, restoredRows: restored });
      });
    } finally {
      await cleanup();
    }
  },
);

export async function* backupJsonChunks(
  generatedBy: string,
  executor: BackupExecutor,
): AsyncGenerator<string> {
  let plaintextBytes = 0;
  const emit = (chunk: string): string => {
    plaintextBytes += Buffer.byteLength(chunk, "utf8");
    if (plaintextBytes > MAX_BACKUP_PLAINTEXT_BYTES) {
      throw new Error("Backup exceeds the 512 MiB export limit");
    }
    return chunk;
  };
  yield emit(`{"version":${BACKUP_VERSION},"generatedAt":${JSON.stringify(
    new Date().toISOString(),
  )},"generatedBy":${JSON.stringify(generatedBy)},"tables":{`);
  for (let tableIndex = 0; tableIndex < TABLES.length; tableIndex += 1) {
    const table = TABLES[tableIndex]!;
    if (tableIndex > 0) yield emit(",");
    yield emit(`${JSON.stringify(table.name)}:[`);
    let offset = 0;
    let rowIndex = 0;
    while (true) {
      // Page each table so a large document table cannot materialize in the
      // Node heap. The page size is deliberately below the restore insert
      // batch size and is bounded independently of response buffering.
      const rows = await executor
        .select()
        .from(table.t as never)
        .orderBy(
          ...table.orderColumns.map((column) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            asc((table.t as any)[column]),
          ),
        )
        .limit(BACKUP_PAGE_ROWS)
        .offset(offset);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (rowIndex > 0) yield emit(",");
        yield emit(JSON.stringify(row));
        rowIndex += 1;
      }
      offset += rows.length;
      if (rows.length < BACKUP_PAGE_ROWS) break;
    }
    yield emit("]");
  }
  yield emit("}}");
}

async function preflightBackupTables(filePath: string): Promise<void> {
  const source = createReadStream(filePath).pipe(
    pick.withParserAsStream({ filter: "tables" }),
  );
  const seen = new Set<string>();
  let depth = 0;
  let pendingTable: string | null = null;
  for await (const token of source as AsyncIterable<{ name: string; value?: unknown }>) {
    if (token.name === "keyValue" && depth === 1) {
      const name = String(token.value ?? "");
      if (!TABLE_BY_NAME.has(name)) throw new Error(`Backup contains unknown table: ${name}`);
      pendingTable = name;
      continue;
    }
    if (pendingTable && token.name === "startArray" && depth === 1) {
      seen.add(pendingTable);
      pendingTable = null;
    } else if (pendingTable && token.name !== "stringChunk") {
      throw new Error(`Backup table "${pendingTable}" is not an array.`);
    }
    if (token.name === "startObject" || token.name === "startArray") depth += 1;
    if (token.name === "endObject" || token.name === "endArray") depth -= 1;
  }
  if (pendingTable) throw new Error(`Backup table "${pendingTable}" is not an array.`);
  const missing = TABLES.map((table) => table.name).filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new Error(`Backup is missing required tables: ${missing.join(", ")}`);
  }
}

async function streamTableRows(
  filePath: string,
  tableName: string,
  insertBatch: (batch: object[]) => Promise<void>,
): Promise<void> {
  const source = createReadStream(filePath)
    .pipe(pick.withParserAsStream({ filter: `tables.${tableName}` }))
    .pipe(streamArray.asStream());
  let batch: object[] = [];
  for await (const entry of source as AsyncIterable<{ value: unknown }>) {
    if (!entry.value || typeof entry.value !== "object" || Array.isArray(entry.value)) {
      throw new Error(`Backup table "${tableName}" contains an invalid row.`);
    }
    batch.push(reviveDates(entry.value as object));
    if (batch.length >= INSERT_BATCH_ROWS) {
      await insertBatch(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await insertBatch(batch);
}

// Read a single top-level number-valued key out of a JSON file without
// loading the whole document.
async function readTopLevelNumber(
  filePath: string,
  key: string,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const fileStream = createReadStream(filePath);
    const pipe = fileStream
      .pipe(pick.withParserAsStream({ filter: key }))
      .pipe(streamValues.asStream());
    let resolved = false;
    const finish = (v: number | undefined, err?: Error) => {
      if (resolved) return;
      resolved = true;
      fileStream.destroy();
      if (err) reject(err);
      else resolve(v);
    };
    pipe.on(
      "data",
      ({ value }: { value: unknown }) => {
        if (typeof value === "number") finish(value);
        else finish(undefined);
      },
    );
    pipe.on("end", () => finish(undefined));
    pipe.on("error", (err: Error) => finish(undefined, err));
    fileStream.on("error", (err: Error) => finish(undefined, err));
  });
}

async function readFilePrefix(filePath: string, length: number): Promise<Buffer> {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// Postgres timestamps come back as strings after JSON.stringify; drizzle's
// insert path expects Date objects for `timestamp` columns. We can't tell
// which keys are timestamps without consulting the schema, so we do a
// best-effort revive: any string that matches an ISO 8601 timestamp gets
// reconstructed. Plain strings (filenames, descriptions) are left alone.
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
function reviveDates<T extends object>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "string" && ISO_RE.test(v)) {
      out[k] = new Date(v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export default router;
