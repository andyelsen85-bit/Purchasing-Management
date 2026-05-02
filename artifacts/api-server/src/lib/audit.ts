import { db, auditLogTable } from "@workspace/db";

export async function audit(
  actorId: number | null,
  action: string,
  target?: string,
  targetId?: number,
  details?: string,
  ip?: string,
): Promise<void> {
  await db.insert(auditLogTable).values({
    actorId: actorId ?? null,
    action,
    target: target ?? null,
    targetId: targetId ?? null,
    details: details ?? null,
    ip: ip ?? null,
  });
}
