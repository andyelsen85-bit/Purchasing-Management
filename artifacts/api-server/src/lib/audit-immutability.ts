import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export const AUDIT_IMMUTABILITY_TRIGGER = "audit_log_immutable";
const AUDIT_IMMUTABILITY_FUNCTION = "prevent_audit_log_mutation";

type SqlExecutor = Pick<typeof db, "execute">;
export type AuditRestoreExecutor = SqlExecutor;

/**
 * Install and verify database-level audit-log protection before the API starts.
 * PostgreSQL trigger metadata is checked explicitly so a missing or altered
 * trigger fails boot rather than silently weakening the audit trail.
 */
export async function installAndVerifyAuditLogProtection(
  database: SqlExecutor = db,
): Promise<void> {
  await database.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION public.${AUDIT_IMMUTABILITY_FUNCTION}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log is immutable'
        USING ERRCODE = '55000';
    END;
    $$
  `));
  await database.execute(sql.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_trigger
         WHERE tgrelid = 'public.audit_log'::regclass
           AND tgname = '${AUDIT_IMMUTABILITY_TRIGGER}'
           AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER ${AUDIT_IMMUTABILITY_TRIGGER}
          BEFORE UPDATE OR DELETE OR TRUNCATE ON public.audit_log
          FOR EACH STATEMENT
          EXECUTE FUNCTION public.${AUDIT_IMMUTABILITY_FUNCTION}();
      END IF;
    END
    $$
  `));
  await database.execute(
    sql.raw(
      `ALTER TABLE public.audit_log ENABLE ALWAYS TRIGGER ${AUDIT_IMMUTABILITY_TRIGGER}`,
    ),
  );

  await verifyAuditLogProtection(database);
}

export async function verifyAuditLogProtection(
  database: SqlExecutor = db,
): Promise<void> {
  const verification = (await database.execute(sql.raw(`
    SELECT EXISTS (
      SELECT 1
        FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE t.tgrelid = 'public.audit_log'::regclass
         AND t.tgname = '${AUDIT_IMMUTABILITY_TRIGGER}'
         AND NOT t.tgisinternal
         AND n.nspname = 'public'
         AND p.proname = '${AUDIT_IMMUTABILITY_FUNCTION}'
         AND t.tgenabled = 'A'
         AND t.tgqual IS NULL
         AND t.tgtype = 58
    ) AS protected
  `))) as { rows?: Array<{ protected: boolean }> };

  if (verification.rows?.[0]?.protected !== true) {
    throw new Error("Required audit_log immutability trigger is not installed correctly");
  }
}

/**
 * Temporarily suspend audit-log protection only within the caller's database
 * transaction. Success restores ALWAYS mode before commit; failure leaves the
 * transaction aborted so PostgreSQL rolls the DISABLE back.
 */
export async function withAuditLogRestoreBypass<T>(
  transaction: AuditRestoreExecutor,
  work: () => Promise<T>,
): Promise<T> {
  await transaction.execute(
    sql.raw(
      `ALTER TABLE public.audit_log DISABLE TRIGGER ${AUDIT_IMMUTABILITY_TRIGGER}`,
    ),
  );
  const result = await work();
  await transaction.execute(
    sql.raw(
      `ALTER TABLE public.audit_log ENABLE ALWAYS TRIGGER ${AUDIT_IMMUTABILITY_TRIGGER}`,
    ),
  );
  return result;
}
