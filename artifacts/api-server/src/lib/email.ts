import nodemailer from "nodemailer";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  userDepartmentsTable,
  notificationsTable,
  type DbNotification,
  type DbWorkflow,
} from "@workspace/db";
import { logger } from "./logger";
import type { WorkflowStep } from "./permissions";
import { getSettings, updateSettingsRecord } from "./settings";

// ─── Step → notification role mapping ────────────────────────────────────────

const STEP_NOTIFY_ROLES: Record<WorkflowStep, string[]> = {
  NEW: [],
  QUOTATION: ["DEPT_MANAGER"],
  VALIDATING_QUOTE_FINANCIAL: ["DEPT_MANAGER"],
  VALIDATING_BY_FINANCIAL: ["FINANCIAL_ALL"],
  GT_INVEST: [],
  ORDERING: ["FINANCIAL_ALL"],
  DELIVERY: ["DEPT_MANAGER"],
  INVOICE: ["FINANCIAL_INVOICE"],
  VALIDATING_INVOICE: ["FINANCIAL_ALL"],
  PAYMENT: ["FINANCIAL_PAYMENT"],
  DONE: [],
  REJECTED: ["DEPT_MANAGER", "DEPT_USER"],
};

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

// ─── SMTP config type ─────────────────────────────────────────────────────────

export interface SmtpConfig {
  enabled?: boolean | null;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
  secure?: boolean | null;
  from?: string | null;
  skipTlsVerify?: boolean | null;
}

export interface NotificationContext {
  workflowId: number;
  step: string;
}

export interface NotificationAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

// ─── Step labels in French ────────────────────────────────────────────────────

const STEP_LABEL_FR: Record<string, string> = {
  NEW: "Nouveau",
  QUOTATION: "Devis",
  VALIDATING_QUOTE_FINANCIAL: "Validation devis",
  VALIDATING_BY_FINANCIAL: "Validation financière",
  GT_INVEST: "GT Invest",
  ORDERING: "Commande",
  DELIVERY: "Livraison",
  INVOICE: "Facture",
  VALIDATING_INVOICE: "Validation facture",
  PAYMENT: "Paiement",
  DONE: "Terminé",
  REJECTED: "Rejeté",
};

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDateFr(d: Date): string {
  return d.toLocaleDateString("fr-FR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── HTML email template ──────────────────────────────────────────────────────

function buildHtmlEmail(
  notifications: DbNotification[],
  appName: string,
): string {
  const dateStr = formatDateFr(new Date());

  const items = notifications
    .map((n) => {
      const stepLabel = STEP_LABEL_FR[n.step] ?? n.step;
      const bodyHtml = escapeHtml(n.body).replace(/\n/g, "<br>");
      const createdStr = n.createdAt
        ? formatDateFr(new Date(n.createdAt))
        : "";
      return `
        <div style="background:#FFFFFF;border:1px solid #E0D5C8;border-radius:8px;margin-bottom:16px;overflow:hidden;">
          <div style="background:#5C3A1E;padding:10px 20px;">
            <span style="color:#E8C9A0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;">${escapeHtml(stepLabel)}</span>
          </div>
          <div style="padding:16px 20px;">
            <div style="color:#1A1209;font-size:15px;font-weight:600;margin-bottom:10px;line-height:1.4;">${escapeHtml(n.subject)}</div>
            <div style="color:#5C4030;font-size:13px;line-height:1.7;">${bodyHtml}</div>
            ${createdStr ? `<div style="color:#A08060;font-size:11px;margin-top:14px;padding-top:10px;border-top:1px solid #F0E8E0;">Reçu le ${escapeHtml(createdStr)}</div>` : ""}
          </div>
        </div>`;
    })
    .join("\n");

  const count = notifications.length;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Notifications — ${escapeHtml(appName)}</title>
</head>
<body style="margin:0;padding:0;background-color:#FAF7F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF7F2;min-height:100vh;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;">

          <!-- Header -->
          <tr>
            <td style="background-color:#5C3A1E;border-radius:8px 8px 0 0;padding:28px 32px;">
              <div style="color:#E8C9A0;font-size:10px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:6px;">Centre Hospitalier du Nord</div>
              <div style="color:#FFFFFF;font-size:22px;font-weight:700;letter-spacing:-0.3px;">${escapeHtml(appName)}</div>
              <div style="color:#C4A882;font-size:12px;margin-top:4px;">Récapitulatif des notifications</div>
            </td>
          </tr>

          <!-- Summary bar -->
          <tr>
            <td style="background-color:#7A4F2D;padding:12px 32px;">
              <span style="color:#FAF7F2;font-size:13px;font-weight:600;">
                ${count} notification${count > 1 ? "s" : ""} en attente
              </span>
              <span style="color:#C4A882;font-size:12px;margin-left:8px;">— ${escapeHtml(dateStr)}</span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color:#FAF7F2;padding:28px 32px 8px;">
              <p style="color:#3C2A1A;font-size:14px;margin:0 0 20px;line-height:1.6;">
                Vous avez des mises à jour sur vos demandes d'achat. Consultez l'application pour agir sur ces workflows.
              </p>
              ${items}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#F3EDE3;border:1px solid #E0D5C8;border-top:none;border-radius:0 0 8px 8px;padding:20px 32px;text-align:center;">
              <div style="color:#8B7355;font-size:12px;line-height:1.8;">
                <strong style="color:#5C3A1E;">${escapeHtml(appName)}</strong><br>
                <span style="color:#A08060;font-size:11px;">Cet e-mail a été envoyé automatiquement. Merci de ne pas y répondre.</span>
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Queue a notification (no immediate send) ─────────────────────────────────

/**
 * Enqueue a workflow step notification. The notification is stored in the
 * database with status QUEUED and will be included in the next batch email
 * sent by `flushNotificationQueue()`.
 */
export async function queueNotification(
  to: string[],
  subject: string,
  body: string,
  ctx: { workflowId: number; step: string },
): Promise<void> {
  if (to.length === 0) return;
  try {
    await db.insert(notificationsTable).values({
      workflowId: ctx.workflowId,
      step: ctx.step,
      channel: "email",
      recipients: to,
      subject,
      body,
      status: "QUEUED",
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "Failed to queue notification");
  }
}

// ─── Flush all queued notifications as one combined HTML email per recipient ──

/**
 * Read every QUEUED notification row, group by recipient, and send one
 * combined HTML email per recipient containing all their pending items.
 * Called by the scheduled batch timer in index.ts and by the admin
 * "Envoyer maintenant" action.
 */
export async function flushNotificationQueue(): Promise<{
  sent: number;
  failed: number;
  skipped: number;
}> {
  const settings = await getSettings();
  const smtp = settings.smtp;

  // Mark lastSentAt regardless so the countdown resets even when SMTP is off.
  const markSent = () =>
    updateSettingsRecord({
      notificationLastSentAt: new Date().toISOString(),
    }).catch(() => {
      /* best-effort */
    });

  if (!smtp.enabled || !smtp.host) {
    const skipped = await db
      .select()
      .from(notificationsTable)
      .then((rows) => rows.filter((r) => r.status === "QUEUED").length);
    await markSent();
    return { sent: 0, failed: 0, skipped };
  }

  // Fetch all QUEUED rows
  const queued = await db
    .select()
    .from(notificationsTable)
    .where(eq(notificationsTable.status, "QUEUED"));

  if (queued.length === 0) {
    await markSent();
    return { sent: 0, failed: 0, skipped: 0 };
  }

  // Group notifications by each recipient email
  const byRecipient = new Map<string, DbNotification[]>();
  for (const n of queued) {
    for (const r of n.recipients) {
      if (!r) continue;
      if (!byRecipient.has(r)) byRecipient.set(r, []);
      byRecipient.get(r)!.push(n);
    }
  }

  // Build transporter
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port ?? 587,
    secure: smtp.secure ?? false,
    auth:
      smtp.username && smtp.password
        ? { user: smtp.username, pass: smtp.password }
        : undefined,
    ...(smtp.skipTlsVerify ? { tls: { rejectUnauthorized: false } } : {}),
  });

  const fromAddr = smtp.from ?? smtp.username ?? "noreply@example.com";
  let sent = 0;
  let failed = 0;
  const successIds = new Set<number>();
  const failedIds = new Set<number>();

  for (const [recipient, notifs] of byRecipient) {
    const subject =
      notifs.length === 1
        ? notifs[0].subject
        : `${notifs.length} nouvelles notifications — ${settings.appName}`;
    const html = buildHtmlEmail(notifs, settings.appName);
    const text = notifs
      .map((n) => `[${STEP_LABEL_FR[n.step] ?? n.step}] ${n.subject}\n\n${n.body}`)
      .join("\n\n---\n\n");

    try {
      await transport.sendMail({ from: fromAddr, to: recipient, subject, text, html });
      for (const n of notifs) successIds.add(n.id);
      sent++;
    } catch (err) {
      logger.warn({ err: String(err), recipient }, "Batch email send failed");
      for (const n of notifs) {
        if (!successIds.has(n.id)) failedIds.add(n.id);
      }
      failed++;
    }
  }

  // Update DB statuses
  const now = new Date();
  if (successIds.size > 0) {
    await db
      .update(notificationsTable)
      .set({ status: "SENT", sentAt: now })
      .where(inArray(notificationsTable.id, Array.from(successIds)));
  }
  if (failedIds.size > 0) {
    await db
      .update(notificationsTable)
      .set({ status: "FAILED", error: "Échec lors de l'envoi groupé" })
      .where(inArray(notificationsTable.id, Array.from(failedIds)));
  }

  await markSent();
  logger.info({ sent, failed }, "Notification batch flush complete");
  return { sent, failed, skipped: 0 };
}

// ─── Immediate send (used for GT Invest PDF packs, test emails, etc.) ─────────

/**
 * Send a notification immediately without queuing. Used for one-off emails
 * that include attachments (GT Invest meeting pack) or are triggered
 * directly by an admin action (SMTP test). Workflow step notifications
 * should use `queueNotification()` instead.
 */
export async function sendNotificationNow(
  cfg: SmtpConfig,
  to: string | string[],
  subject: string,
  text: string,
  ctx?: NotificationContext,
  attachments?: NotificationAttachment[],
): Promise<boolean> {
  const recipients = Array.isArray(to) ? to : [to];

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
      ...(cfg.skipTlsVerify ? { tls: { rejectUnauthorized: false } } : {}),
    });
    await transport.sendMail({
      from: cfg.from ?? cfg.username ?? "noreply@example.com",
      to: recipients.join(","),
      subject,
      text,
      ...(attachments && attachments.length > 0
        ? {
            attachments: attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              contentType: a.contentType,
            })),
          }
        : {}),
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

// Backward-compat alias — gtInvest.ts calls sendNotification with attachments.
export { sendNotificationNow as sendNotification };
