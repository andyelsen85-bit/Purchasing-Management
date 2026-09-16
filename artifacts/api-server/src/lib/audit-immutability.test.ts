import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import {
  AUDIT_IMMUTABILITY_TRIGGER,
  installAndVerifyAuditLogProtection,
  verifyAuditLogProtection,
  withAuditLogRestoreBypass,
} from "./audit-immutability";

async function assertNormalMutationIsRejected(): Promise<void> {
  await assert.rejects(
    pool.query("UPDATE audit_log SET details = details WHERE false"),
    /audit_log is immutable/,
  );
}

test("database rejects direct audit_log update, delete, and truncate", async () => {
  await installAndVerifyAuditLogProtection();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ id: number }>(
      "INSERT INTO audit_log (action, target) VALUES ($1, $2) RETURNING id",
      ["IMMUTABILITY_TEST", "test"],
    );
    const id = inserted.rows[0]!.id;
    const attempts: Array<[string, unknown[]]> = [
      ["UPDATE audit_log SET details = $1 WHERE id = $2", ["tampered", id]],
      ["DELETE FROM audit_log WHERE id = $1", [id]],
      ["TRUNCATE audit_log", []],
    ];

    for (const [statement, params] of attempts) {
      await client.query("SAVEPOINT audit_mutation_attempt");
      await assert.rejects(
        client.query(statement, params),
        /audit_log is immutable/,
      );
      await client.query("ROLLBACK TO SAVEPOINT audit_mutation_attempt");
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test("startup verification rejects disabled, replica-only, and altered triggers", async () => {
  await installAndVerifyAuditLogProtection();
  try {
    for (const mode of ["DISABLE", "ENABLE REPLICA"] as const) {
      await db.execute(
        sql.raw(
          `ALTER TABLE public.audit_log ${mode} TRIGGER ${AUDIT_IMMUTABILITY_TRIGGER}`,
        ),
      );
      await assert.rejects(
        verifyAuditLogProtection(),
        /immutability trigger is not installed correctly/,
      );
      await installAndVerifyAuditLogProtection();
    }

    await db.execute(
      sql.raw(`DROP TRIGGER ${AUDIT_IMMUTABILITY_TRIGGER} ON public.audit_log`),
    );
    await db.execute(sql.raw(`
      CREATE TRIGGER ${AUDIT_IMMUTABILITY_TRIGGER}
        BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.audit_log
        FOR EACH STATEMENT
        EXECUTE FUNCTION public.prevent_audit_log_mutation()
    `));
    await db.execute(
      sql.raw(
        `ALTER TABLE public.audit_log ENABLE ALWAYS TRIGGER ${AUDIT_IMMUTABILITY_TRIGGER}`,
      ),
    );
    await assert.rejects(
      verifyAuditLogProtection(),
      /immutability trigger is not installed correctly/,
    );
  } finally {
    await db.execute(
      sql.raw(`DROP TRIGGER IF EXISTS ${AUDIT_IMMUTABILITY_TRIGGER} ON public.audit_log`),
    );
    await installAndVerifyAuditLogProtection();
  }
});

test("restore bypass re-enables protection before success and after rollback", async () => {
  await installAndVerifyAuditLogProtection();
  await assert.rejects(
    db.transaction(async (tx) => {
      await withAuditLogRestoreBypass(tx, async () => {
        await tx.execute(sql.raw("TRUNCATE public.audit_log"));
      });
      await verifyAuditLogProtection(tx);
      throw new Error("test-success-path-rollback");
    }),
    /test-success-path-rollback/,
  );
  await verifyAuditLogProtection();
  await assertNormalMutationIsRejected();

  await assert.rejects(
    db.transaction(async (tx) => {
      await withAuditLogRestoreBypass(tx, async () => {
        await tx.execute(sql.raw("TRUNCATE public.audit_log"));
        throw new Error("injected-restore-failure");
      });
    }),
    /injected-restore-failure/,
  );
  await verifyAuditLogProtection();
  await assertNormalMutationIsRejected();
});