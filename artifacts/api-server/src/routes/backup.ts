import { Router, type IRouter } from "express";
import multer from "multer";
import { sql } from "drizzle-orm";
import { createReadStream, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import pick from "stream-json/filters/pick.js";
import streamObject from "stream-json/streamers/stream-object.js";
import streamValues from "stream-json/streamers/stream-values.js";
import {
  db,
  usersTable,
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
  tlsTable,
} from "@workspace/db";
import { requireAuth, requireRole, getUser } from "../middlewares/auth";
import { audit } from "../lib/audit";

const router: IRouter = Router();

// 10 GiB ceiling on the uploaded JSON. We can support files this large
// because we never load the dump into memory: multer streams it to a
// temp file on disk and we then stream-parse it table-by-table with
// `stream-json`. Raise this if you genuinely have a bigger backup
// (production VM disk space is the real constraint at that point).
const TEN_GIB = 10 * 1024 * 1024 * 1024;
const RESTORE_TMP_DIR = path.join(tmpdir(), "purchasing-restore");
await fsp.mkdir(RESTORE_TMP_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: RESTORE_TMP_DIR }),
  limits: { fileSize: TEN_GIB },
});

// Tables in FK-safe order: parents first when inserting, children first
// when truncating. We keep both lists explicit (rather than deriving)
// so a future schema change has to come back through this file.
const TABLES = [
  { name: "users", t: usersTable, hasSerial: true },
  { name: "departments", t: departmentsTable, hasSerial: true },
  { name: "user_departments", t: userDepartmentsTable, hasSerial: false },
  { name: "companies", t: companiesTable, hasSerial: true },
  { name: "contacts", t: contactsTable, hasSerial: true },
  { name: "workflows", t: workflowsTable, hasSerial: true },
  { name: "documents", t: documentsTable, hasSerial: true },
  { name: "document_versions", t: documentVersionsTable, hasSerial: true },
  { name: "workflow_steps", t: workflowStepsTable, hasSerial: true },
  { name: "notes", t: notesTable, hasSerial: true },
  { name: "history", t: historyTable, hasSerial: true },
  { name: "audit_log", t: auditLogTable, hasSerial: true },
  { name: "settings", t: settingsTable, hasSerial: true },
  { name: "gt_invest_dates", t: gtInvestDatesTable, hasSerial: true },
  { name: "gt_invest_results", t: gtInvestResultsTable, hasSerial: true },
  { name: "notifications", t: notificationsTable, hasSerial: true },
  { name: "tls_state", t: tlsTable, hasSerial: true },
] as const;

const TABLE_BY_NAME: Map<string, (typeof TABLES)[number]> = new Map(
  TABLES.map((x) => [x.name as string, x]),
);
const BACKUP_VERSION = 1;

// Postgres caps prepared-statement parameters at 65 535. Our widest
// tables have ~25 columns, so 1 000 rows per INSERT keeps us well
// inside that limit while still amortising round-trips.
const INSERT_BATCH_ROWS = 1000;

/**
 * GET /api/admin/backup
 *
 * Dumps every persisted table (except `sessions`, which is transient)
 * to a single JSON file. Document blobs are already stored base64 in
 * the `documents` / `document_versions` tables, so this dump is
 * fully self-contained — no separate uploads tarball to wrangle.
 */
router.get(
  "/admin/backup",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const out: Record<string, unknown[]> = {};
    for (const { name, t } of TABLES) {
      out[name] = await db.select().from(t);
    }
    const payload = {
      version: BACKUP_VERSION,
      generatedAt: new Date().toISOString(),
      generatedBy: getUser(req).username,
      tables: out,
    };
    const filename = `purchasing-backup-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    await audit(getUser(req).id, "BACKUP", "system", undefined, filename, req.ip);
    res.send(JSON.stringify(payload));
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
 * The dump is processed as a stream from a temp file on disk — we
 * never materialise the whole JSON in memory, so dumps up to 10 GiB
 * (and beyond, with a config bump) are supported without OOMing the
 * Node heap.
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
    const cleanup = async () => {
      await fsp.unlink(filePath).catch(() => {
        /* best-effort temp file cleanup */
      });
    };

    try {
      // ---- Pass 1: validate the version header before we touch the DB.
      // Streams just the top-level `version` value out of the file and
      // tears the parser down as soon as we have it.
      let version: number | undefined;
      try {
        version = await readTopLevelNumber(filePath, "version");
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

      // ---- Pass 2: open transaction, truncate, stream `tables.*` and
      // batch-insert each table as it arrives. Track which tables we
      // actually saw so we can abort on a partial dump.
      const actor = getUser(req);
      const seen = new Set<string>();
      let restored = 0;

      try {
        await db.transaction(async (tx) => {
          // CASCADE so child FKs (when present) follow; RESTART IDENTITY
          // so sequences zero out before we re-seed them.
          const all = TABLES.map((x) => `"${x.name}"`).join(", ");
          await tx.execute(
            sql.raw(`truncate ${all} restart identity cascade`),
          );
          // Also clear sessions so no pre-restore cookie keeps working.
          await tx.execute(sql.raw(`truncate "sessions"`));

          // Stream every entry under `tables.*` — the streamer emits
          // one `{key, value}` per table, which for a 10 GiB dump
          // means each individual table value still has to fit in
          // memory. That's fine for our schema (no single table is
          // expected to be multi-GB on its own); if that ever changes,
          // we'd switch to a per-row streamer (`StreamArray` under
          // `tables.<name>`) and skip the up-front object collection.
          // pick().withParserAsStream() returns a Duplex that consumes
          // the raw byte stream and emits parser tokens for everything
          // matching `tables`; streamObject.asStream() then assembles
          // each top-level property of `tables` into a `{key, value}`
          // pair. Both are classic Node Duplex streams, so node's
          // promise-pipeline drains them cleanly and propagates errors.
          const source = createReadStream(filePath)
            .pipe(pick.withParserAsStream({ filter: "tables" }))
            .pipe(streamObject.asStream());

          await pipeline(source, async (entries) => {
            for await (const entry of entries as AsyncIterable<{
              key: string;
              value: unknown;
            }>) {
              const name = entry.key;
              const meta = TABLE_BY_NAME.get(name);
              if (!meta) {
                throw new Error(
                  `Backup contains unknown table: ${name}`,
                );
              }
              if (!Array.isArray(entry.value)) {
                throw new Error(
                  `Backup table "${name}" is not an array.`,
                );
              }
              seen.add(name);
              const rows = entry.value;
              for (let i = 0; i < rows.length; i += INSERT_BATCH_ROWS) {
                const slice = rows.slice(i, i + INSERT_BATCH_ROWS);
                const revived = slice.map((row) =>
                  reviveDates(row as object),
                );
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await tx.insert(meta.t as any).values(revived as any);
                restored += revived.length;
              }
            }
          });

          // Strict completeness check — a partial dump (missing some
          // tables) would silently leave us with TRUNCATE'd tables and
          // no replacement rows. Throwing here rolls the whole
          // transaction back, restoring the pre-restore state.
          const missing = TABLES.map((x) => x.name).filter(
            (n) => !seen.has(n),
          );
          if (missing.length > 0) {
            throw new Error(
              `Backup is missing required tables: ${missing.join(", ")}`,
            );
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

// Read a single top-level number-valued key out of a JSON file without
// loading the whole document. Resolves to `undefined` if the key is
// missing. We tear the underlying read stream down as soon as we get
// the value so a 10 GiB dump finishes in milliseconds.
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
