import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import ConnectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";

const PgStore = ConnectPgSimple(session);

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

const WEAK_SECRETS = new Set([
  "dev-secret-change-me",
  "change-me",
  "change-me-to-a-long-random-string",
  "secret",
  "changeme",
]);
const rawSecret = process.env.SESSION_SECRET;
if (process.env.NODE_ENV === "production") {
  if (!rawSecret || rawSecret.length < 32 || WEAK_SECRETS.has(rawSecret)) {
    // eslint-disable-next-line no-console
    console.error(
      "FATAL: SESSION_SECRET must be set to a strong value (>=32 chars, not a known placeholder) in production.",
    );
    process.exit(1);
  }
}
const sessionSecret = rawSecret ?? "dev-secret-change-me";

// CORS — in production, restrict to a comma-separated allowlist via
// CORS_ORIGINS. In development we reflect the request origin so the local
// proxy / preview can talk to the API across artifact ports.
const corsAllowlist = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// When CORS_ORIGINS is not set in production the app is assumed to be
// deployed in single-origin mode (SPA + API served by the same process
// via WEB_DIST). Same-origin requests work fine — no warning needed.
// CORS is scoped to /api below — static SPA assets must NOT go through
// CORS at all. The browser sometimes sends an Origin header on
// same-origin asset loads (e.g. <script crossorigin>, modulepreload),
// which would be incorrectly rejected by the allowlist check.
//
// We use the per-request form of cors() so the same-origin check can
// inspect the actual request Host. Modern browsers send an Origin
// header even on same-origin POSTs/fetch (`https://app.example.com`
// hitting `https://app.example.com/api/…`), so a naive "no Origin =
// same-origin" check is not enough — we must compare the Origin's host
// to the request's effective host (X-Forwarded-Host first, then Host).
const corsMiddleware = cors((req, cb) => {
  const origin = req.headers.origin;
  if (process.env.NODE_ENV !== "production") {
    return cb(null, { credentials: true, origin: true });
  }
  if (!origin) return cb(null, { credentials: true, origin: true });
  // Same-origin: Origin host == request host (honour X-Forwarded-Host
  // because we sit behind nginx/Caddy/etc. on commande.hostzone.lu).
  const fwdHost =
    (req.headers["x-forwarded-host"] as string | undefined) ??
    (req.headers.host as string | undefined);
  try {
    const originHost = new URL(origin).host;
    if (fwdHost && originHost === fwdHost) {
      return cb(null, { credentials: true, origin: true });
    }
  } catch {
    /* malformed Origin — fall through to allowlist */
  }
  if (corsAllowlist.includes(origin)) {
    return cb(null, { credentials: true, origin: true });
  }
  cb(new Error(`Origin ${origin} not allowed by CORS`), { origin: false });
});
app.use(express.json({ limit: "32mb" }));
app.use(express.urlencoded({ extended: true, limit: "32mb" }));

// Use PostgreSQL as the session store in production so sessions survive
// container restarts and scale across processes. Falls back to the
// default MemoryStore only in development (where DATABASE_URL may not
// be set and the MemoryStore warning is acceptable).
// Use the shared pg Pool from @workspace/db so we don't open a second
// connection pool. The "session" table is defined in the Drizzle schema
// and created by `db push` — no createTableIfMissing needed (which would
// try to read a bundled SQL file that esbuild cannot resolve at runtime).
const sessionStore =
  process.env.NODE_ENV === "production"
    ? new PgStore({
        pool,
        tableName: "session",
        pruneSessionInterval: 60 * 60,
      })
    : undefined; // undefined = default MemoryStore (dev only)

app.use(
  session({
    store: sessionStore,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    proxy: true, // trust X-Forwarded-Proto for "secure" cookie decisions
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // `secure: "auto"` lets express-session set the cookie as Secure
      // only when the request was actually served over HTTPS (or when
      // a trusted reverse proxy says it was via X-Forwarded-Proto).
      // Marking it unconditionally Secure in production deadlocks the
      // first-boot HTTPS bootstrap: the server starts on plain HTTP
      // until an admin imports a certificate via the cert UI, but the
      // browser would never send the session cookie back over HTTP, so
      // the admin couldn't sign in to do that import.
      secure: "auto",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  }),
);

app.use("/api", corsMiddleware, router);

// Optional SPA passthrough: when WEB_DIST is set (Docker / production), the
// API process also serves the built React app and falls back to index.html
// for any non-/api GET so client-side routing works on direct URLs.
const webDist = process.env.WEB_DIST;
if (webDist) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  const indexHtml = path.join(webDist, "index.html");
  app.use(express.static(webDist, { index: false, maxAge: "1h" }));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(indexHtml);
  });
}

export default app;
