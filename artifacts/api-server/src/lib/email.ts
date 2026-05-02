import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  userDepartmentsTable,
  notificationsTable,
  type DbWorkflow,
} from "@workspace/db";
import { logger } from "./logger";
import type { WorkflowStep } from "./permissions";

// Map each step to the role(s) that should receive an alert when a
// workflow reaches that step. The workflow creator is always added on
// top of these by recipientsForStep().
//
// Step numbering (per spec):
//   1 NEW                          — creator only
//   2 QUOTATION                    — submitter's department gathers quotes
//   3 VALIDATING_QUOTE_FINANCIAL   — Department Manager approves the quote
//   4 VALIDATING_BY_FINANCIAL      — Financial team reviews
//   4a GT_INVEST                   — GT Invest committee (only when triggered)
//   5 ORDERING                     — Financial places the order
//   6 DELIVERY                     — Department receives the goods
//   7 INVOICE                      — Financial-Invoice records the invoice
//   8 VALIDATING_INVOICE           — Financial-Invoice + Financial-All sign-off
//   9 PAYMENT                      — Financial-Payment executes the transfer
const STEP_NOTIFY_ROLES: Record<WorkflowStep, string[]> = {
  NEW: [],
  QUOTATION: ["DEPT_MANAGER"],
  VALIDATING_QUOTE_FINANCIAL: ["DEPT_MANAGER"],
  VALIDATING_BY_FINANCIAL: ["FINANCIAL_ALL"],
  GT_INVEST: ["GT_INVEST"],
  ORDERING: ["FINANCIAL_ALL"],
  DELIVERY: ["DEPT_MANAGER"],
  INVOICE: ["FINANCIAL_INVOICE"],
  VALIDATING_INVOICE: ["FINANCIAL_ALL"],
  PAYMENT: ["FINANCIAL_PAYMENT"],
  DONE: [],
  // Reject closes the workflow. Notify the originating department
  // (manager + users) so they know their request will not progress.
  REJECTED: ["DEPT_MANAGER", "DEPT_USER"],
};

/**
 * Resolve the email recipients for a workflow that just entered `step`.
 * Always includes the workflow creator, plus any users with one of the
 * step-specific roles. Department-scoped roles are filtered to the
 * workflow's department; cross-department roles are not.
 */
export async function recipientsForStep(
  workflow: Pick<DbWorkflow, "id" | "departmentId" | "createdById">,
  step: WorkflowStep,
): Promise<string[]> {
  const roles = STEP_NOTIFY_ROLES[step] ?? [];
  const emails = new Set<string>();

  const [creator] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, workflow.createdById));
  if (creator?.email) emails.add(creator.email);

  if (roles.length === 0) return Array.from(emails);

  const candidates = await db.select().from(usersTable);
  const deptScoped = new Set(["DEPT_USER", "DEPT_MANAGER"]);
  const inDept = await db
    .select()
    .from(userDepartmentsTable)
    .where(eq(userDepartmentsTable.departmentId, workflow.departmentId));
  const deptUserIds = new Set(inDept.map((r) => r.userId));

  for (const u of candidates) {
    if (!u.email) continue;
    const userRoles = (u.roles as string[] | null) ?? [];
    const matches = userRoles.some((r) => roles.includes(r));
    if (!matches) continue;
    const isDeptScoped = userRoles.every((r) => deptScoped.has(r));
    if (isDeptScoped && !deptUserIds.has(u.id)) continue;
    emails.add(u.email);
  }
  return Array.from(emails);
}

export interface SmtpConfig {
  enabled?: boolean | null;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
  secure?: boolean | null;
  from?: string | null;
}

export interface NotificationContext {
  workflowId: number;
  step: string;
}

export async function sendNotification(
  cfg: SmtpConfig,
  to: string | string[],
  subject: string,
  text: string,
  ctx?: NotificationContext,
): Promise<boolean> {
  const recipients = Array.isArray(to) ? to : [to];

  // Always persist the fan-out attempt — the /notifications feed and the
  // audit story should reflect what we tried to send, not just successes.
  // Skips if no workflow context (e.g. ad-hoc admin email).
  let notifId: number | null = null;
  if (ctx) {
    try {
      const [row] = await db
        .insert(notificationsTable)
        .values({
          workflowId: ctx.workflowId,
          step: ctx.step,
          channel: "email",
          recipients,
          subject,
          body: text,
          status: cfg.enabled && cfg.host ? "PENDING" : "FAILED",
          error: cfg.enabled && cfg.host ? null : "SMTP disabled",
        })
        .returning({ id: notificationsTable.id });
      notifId = row?.id ?? null;
    } catch (err) {
      logger.warn({ err: String(err) }, "Failed to persist notification row");
    }
  }

  if (!cfg.enabled || !cfg.host) {
    logger.debug({ subject, to }, "SMTP disabled — notification skipped");
    return false;
  }
  try {
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port ?? 587,
      secure: cfg.secure ?? false,
      auth:
        cfg.username && cfg.password
          ? { user: cfg.username, pass: cfg.password }
          : undefined,
    });
    await transport.sendMail({
      from: cfg.from ?? cfg.username ?? "noreply@example.com",
      to: recipients.join(","),
      subject,
      text,
    });
    if (notifId != null) {
      await db
        .update(notificationsTable)
        .set({ status: "SENT", sentAt: new Date() })
        .where(eq(notificationsTable.id, notifId));
    }
    return true;
  } catch (err) {
    logger.warn({ err: String(err) }, "Failed to send notification email");
    if (notifId != null) {
      await db
        .update(notificationsTable)
        .set({ status: "FAILED", error: String(err) })
        .where(eq(notificationsTable.id, notifId));
    }
    return false;
  }
}
