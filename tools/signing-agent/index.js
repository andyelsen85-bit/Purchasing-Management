#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { execFile } = require("child_process");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 9443);
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || "./agent.crt";
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || "./agent.key";
const SHARED_TOKEN = process.env.SHARED_TOKEN || "";
const CERT_TEMPLATE = process.env.CERT_TEMPLATE || "WebServer";
const CA_CONFIG = process.env.CA_CONFIG || "";

if (!SHARED_TOKEN) {
  console.error("FATAL: SHARED_TOKEN environment variable is required.");
  process.exit(1);
}
if (!fs.existsSync(TLS_CERT_PATH) || !fs.existsSync(TLS_KEY_PATH)) {
  console.error(
    `FATAL: TLS files not found. Set TLS_CERT_PATH (=${TLS_CERT_PATH}) and TLS_KEY_PATH (=${TLS_KEY_PATH}).`,
  );
  process.exit(1);
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a || "", "utf8");
  const bb = Buffer.from(b || "", "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function authorize(req, res) {
  const header = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m || !timingSafeEqual(m[1], SHARED_TOKEN)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }
  return true;
}

function readJsonBody(req, max = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > max) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function tempFile(prefix, suffix) {
  return path.join(
    os.tmpdir(),
    `${prefix}-${crypto.randomBytes(8).toString("hex")}${suffix}`,
  );
}

function runCertReq(csrPath, certPath, template) {
  return new Promise((resolve, reject) => {
    const args = ["-submit", "-attrib", `CertificateTemplate:${template}`];
    if (CA_CONFIG) args.push("-config", CA_CONFIG);
    args.push(csrPath, certPath);
    execFile("certreq.exe", args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`certreq failed: ${stderr || stdout || err.message}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function handleSign(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err.message || err) }));
    return;
  }
  const csrPem = String(body.csrPem || "");
  const template = String(body.template || CERT_TEMPLATE);
  if (!/-----BEGIN CERTIFICATE REQUEST-----/.test(csrPem)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "csrPem missing or malformed" }));
    return;
  }

  const csrPath = tempFile("csr", ".req");
  const certPath = tempFile("cert", ".cer");
  try {
    fs.writeFileSync(csrPath, csrPem, "utf8");
    await runCertReq(csrPath, certPath, template);
    const certPem = fs.readFileSync(certPath, "utf8");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ certPem }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  } finally {
    for (const p of [csrPath, certPath]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

const server = https.createServer(
  {
    cert: fs.readFileSync(TLS_CERT_PATH),
    key: fs.readFileSync(TLS_KEY_PATH),
  },
  (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "0.1.0" }));
      return;
    }
    if (!authorize(req, res)) return;
    if (req.method === "POST" && req.url === "/sign") {
      handleSign(req, res);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  },
);

server.listen(PORT, () => {
  console.log(`Signing agent listening on https://0.0.0.0:${PORT}`);
});
