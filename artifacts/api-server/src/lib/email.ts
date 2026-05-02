import nodemailer from "nodemailer";
import { logger } from "./logger";

export interface SmtpConfig {
  enabled?: boolean | null;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
  secure?: boolean | null;
  from?: string | null;
}

export async function sendNotification(
  cfg: SmtpConfig,
  to: string | string[],
  subject: string,
  text: string,
): Promise<boolean> {
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
      to: Array.isArray(to) ? to.join(",") : to,
      subject,
      text,
    });
    return true;
  } catch (err) {
    logger.warn({ err: String(err) }, "Failed to send notification email");
    return false;
  }
}
