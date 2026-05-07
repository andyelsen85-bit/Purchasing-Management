import http from "node:http";
import https from "node:https";
import app from "./app";
import { logger } from "./lib/logger";
import { db, tlsTable } from "@workspace/db";
import { runStartupMigrations } from "./lib/startup-migrations";
import { getSettings } from "./lib/settings";
import { flushNotificationQueue } from "./lib/email";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function loadTlsMaterial(): Promise<{ key: string; cert: string } | null> {
  try {
    const [row] = await db.select().from(tlsTable).limit(1);
    if (!row?.certPem || !row?.privateKeyPem) return null;
    const cert = row.chainPem
      ? `${row.certPem.trim()}\n${row.chainPem.trim()}\n`
      : row.certPem;
    return { key: row.privateKeyPem, cert };
  } catch (err) {
    logger.warn({ err: String(err) }, "Could not load TLS material from DB");
    return null;
  }
}

let httpServer: http.Server | null = null;
let httpsServer: https.Server | null = null;

function makeRedirector(httpsPort: number) {
  return http.createServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    const target =
      httpsPort === 443
        ? `https://${host}${req.url ?? "/"}`
        : `https://${host}:${httpsPort}${req.url ?? "/"}`;
    res.writeHead(301, { Location: target });
    res.end();
  });
}

async function configureListeners(): Promise<{ ok: boolean; mode: string }> {
  const httpsPortRaw = process.env["HTTPS_PORT"];
  const httpsPort = httpsPortRaw ? Number(httpsPortRaw) : null;
  const tls = httpsPort ? await loadTlsMaterial() : null;

  // Tear down whatever's currently bound so we can rebind cleanly.
  if (httpsServer) {
    await new Promise<void>((r) => httpsServer!.close(() => r()));
    httpsServer = null;
  }
  if (httpServer) {
    await new Promise<void>((r) => httpServer!.close(() => r()));
    httpServer = null;
  }

  if (httpsPort && tls) {
    httpsServer = https.createServer({ key: tls.key, cert: tls.cert }, app);
    await new Promise<void>((r) => httpsServer!.listen(httpsPort, r));
    logger.info({ port: httpsPort, mode: "https" }, "HTTPS listener ready");

    httpServer = makeRedirector(httpsPort);
    await new Promise<void>((r) => httpServer!.listen(port, r));
    logger.info(
      { port, mode: "http-redirect" },
      "HTTP→HTTPS redirector ready",
    );
    return { ok: true, mode: "https" };
  }

  httpServer = http.createServer(app);
  await new Promise<void>((r) => httpServer!.listen(port, r));
  logger.info(
    { port, mode: "http", httpsConfigured: !!httpsPort },
    "Server listening",
  );
  return { ok: true, mode: "http" };
}

// Expose a hot-reload entrypoint for the /admin/cert/reload route.
(globalThis as {
  __reloadHttps?: () => Promise<{ ok: boolean; mode: string }>;
}).__reloadHttps = configureListeners;

// ─── Notification batch timer ──────────────────────────────────────────────────
// Checks every 60 seconds whether the configured notification interval has
// elapsed since the last flush, and if so sends all queued notifications as
// one combined HTML email per recipient.
setInterval(() => {
  void (async () => {
    try {
      const settings = await getSettings();
      const intervalMs = (settings.notificationIntervalMinutes ?? 15) * 60 * 1000;
      const lastSentMs = settings.notificationLastSentAt
        ? new Date(settings.notificationLastSentAt).getTime()
        : 0;
      if (Date.now() - lastSentMs >= intervalMs) {
        const result = await flushNotificationQueue();
        if (result.sent > 0 || result.failed > 0) {
          logger.info(result, "Notification batch flush completed");
        }
      }
    } catch (err) {
      logger.warn({ err: String(err) }, "Notification batch timer error");
    }
  })();
}, 60_000);

void (async () => {
  try {
    await runStartupMigrations();
  } catch (err) {
    logger.error({ err }, "Startup migrations failed; aborting boot");
    process.exit(1);
  }
  await configureListeners();
})().catch((err) => {
  logger.error({ err }, "Failed to start listeners");
  process.exit(1);
});
