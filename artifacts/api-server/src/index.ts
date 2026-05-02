import http from "node:http";
import https from "node:https";
import app from "./app";
import { logger } from "./lib/logger";
import { db, tlsTable } from "@workspace/db";

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

async function start(): Promise<void> {
  const httpsPortRaw = process.env["HTTPS_PORT"];
  const httpsPort = httpsPortRaw ? Number(httpsPortRaw) : null;
  const tls = httpsPort ? await loadTlsMaterial() : null;

  if (httpsPort && tls) {
    https
      .createServer({ key: tls.key, cert: tls.cert }, app)
      .listen(httpsPort, () => {
        logger.info({ port: httpsPort, mode: "https" }, "HTTPS listener ready");
      });
    // The plain port becomes a 301 redirector to HTTPS.
    http
      .createServer((req, res) => {
        const host = (req.headers.host ?? "").split(":")[0];
        const target =
          httpsPort === 443
            ? `https://${host}${req.url ?? "/"}`
            : `https://${host}:${httpsPort}${req.url ?? "/"}`;
        res.writeHead(301, { Location: target });
        res.end();
      })
      .listen(port, () => {
        logger.info({ port, mode: "http-redirect" }, "HTTP→HTTPS redirector ready");
      });
    return;
  }

  // No cert configured — serve plain HTTP. The HTTPS Management UI lets
  // operators import a cert; restart picks it up.
  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info(
      { port, mode: "http", httpsConfigured: !!httpsPort },
      "Server listening",
    );
  });
}

void start();
