import { Router, type IRouter } from "express";
import multer from "multer";
import { sql } from "drizzle-orm";
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

// 256 MiB ceiling — backups embed every uploaded document as base64 in
// the documents table, so the dump can grow large. Operators on tiny
// VMs can lower this via env later if it becomes a problem.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 256 * 1024 * 1024 },
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

const BACKUP_VERSION = 1;

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
    let parsed: {
      version?: number;
      tables?: Record<string, unknown[]>;
    };
    try {
      parsed = JSON.parse(req.file.buffer.toString("utf8"));
    } catch (err) {
      res.status(400).json({
        error: `Backup is not valid JSON: ${(err as Error).message}`,
      });
      return;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== BACKUP_VERSION ||
      !parsed.tables ||
      typeof parsed.tables !== "object"
    ) {
      res.status(400).json({
        error: `Unrecognized backup format. Expected version ${BACKUP_VERSION}.`,
      });
      return;
    }
    const tables = parsed.tables;
    // Validate that every key in the dump corresponds to a known table —
    // refuse the restore otherwise so we don't silently drop data the
    // operator thought was being restored.
    const known = new Set<string>(TABLES.map((x) => x.name));
    const unknown = Object.keys(tables).filter((k) => !known.has(k));
    if (unknown.length > 0) {
      res.status(400).json({
        error: `Backup contains unknown tables: ${unknown.join(", ")}`,
      });
      return;
    }
    // Strict completeness check — a partial dump (missing some tables)
    // would silently TRUNCATE everything and only re-seed a subset,
    // which is destructive. Reject before we touch the DB.
    const missing = TABLES.map((x) => x.name).filter(
      (n) => !Array.isArray(tables[n]),
    );
    if (missing.length > 0) {
      res.status(400).json({
        error: `Backup is missing required tables: ${missing.join(", ")}`,
      });
      return;
    }

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
        // Also clear sessions so no pre-restore cookie keeps working.
        await tx.execute(sql.raw(`truncate "sessions"`));
        for (const { name, t } of TABLES) {
          const rows = tables[name];
          if (!Array.isArray(rows) || rows.length === 0) continue;
          // Drizzle's insert accepts arrays of plain objects whose keys
          // match the schema's TS field names (camelCase). The dump was
          // produced by `db.select().from(t)`, so the shape already
          // matches — we just need to revive Date columns from the
          // serialized ISO strings.
          const revived = rows.map((row) => reviveDates(row as object));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await tx.insert(t as any).values(revived as any);
          restored += revived.length;
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
      res
        .status(500)
        .json({ error: `Restore failed: ${(err as Error).message}` });
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
  },
);

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
