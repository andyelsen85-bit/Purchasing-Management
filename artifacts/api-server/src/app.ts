import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

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

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "32mb" }));
app.use(express.urlencoded({ extended: true, limit: "32mb" }));

app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  }),
);

app.use("/api", router);

export default app;
