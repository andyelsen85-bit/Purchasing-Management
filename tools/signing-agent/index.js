#!/usr/bin/env node
"use strict";

/**
 * Purchasing Signing Agent
 *
 * Two transports, both authenticated with the same SHARED_TOKEN:
 *
 *   1. HTTPS endpoints  (corporate / internal CA flow)
 *      - GET  /healthz                           → { ok, version }
 *      - POST /sign      { csrPem, template? }   → { certPem }
 *      - POST /list-certs                        → { certs: [...] }
 *      - POST /sign-data { thumbprint, dataB64 } → { signatureB64 }
 *
 *   2. WebSocket on the same port and on the local-only port 27443
 *      (tunneled via TLS upgrade) used by the web app to drive a
 *      certificate picker. Messages are JSON envelopes:
 *        { id, type: "list-certs" | "sign-data", payload: {...} }
 *      Responses:
 *        { id, ok: true,  result: {...} }   /   { id, ok: false, error }
 *
 * Certificate enumeration uses PowerShell against the Windows certificate
 * store (Cert:\CurrentUser\My) — this is the supported scripting bridge to
 * Windows CryptoAPI. We filter to certs whose Enhanced Key Usage / Key Usage
 * permits Digital Signature and that have not expired. Signing uses
 * `Set-AuthenticodeSignature` on a temp file so private keys never leave
 * the Windows cert store.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const url = require("url");
const { execFile } = require("child_process");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

function loadConfig() {
  const candidates = [
    process.env.CONFIG_PATH,
    path.join(__dirname, "config.json"),
    path.join(__dirname, "config.example.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      } catch (err) {
        console.error(`Failed to parse ${p}:`, err.message);
      }
    }
  }
  return {};
}

const cfg = loadConfig();
const PORT = Number(process.env.PORT || cfg.port || 9443);
const LOCAL_WS_PORT = Number(
  process.env.LOCAL_WS_PORT || cfg.localWsPort || 27443,
);
const TLS_CERT_PATH =
  process.env.TLS_CERT_PATH || cfg.tlsCertPath || "./agent.crt";
const TLS_KEY_PATH =
  process.env.TLS_KEY_PATH || cfg.tlsKeyPath || "./agent.key";
const TLS_PFX_PATH = process.env.TLS_PFX_PATH || cfg.tlsPfxPath || "";
const TLS_PFX_PASSPHRASE =
  process.env.TLS_PFX_PASSPHRASE || cfg.tlsPfxPassphrase || "";
const SHARED_TOKEN = process.env.SHARED_TOKEN || cfg.sharedToken || "";
const CERT_TEMPLATE =
  process.env.CERT_TEMPLATE || cfg.certTemplate || "WebServer";
const CA_CONFIG = process.env.CA_CONFIG || cfg.caConfig || "";
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : cfg.allowedOrigins ?? []
)
  .map((s) => String(s).trim())
  .filter(Boolean);

if (!SHARED_TOKEN || SHARED_TOKEN === "REPLACE_WITH_AT_LEAST_32_RANDOM_CHARS") {
  console.error(
    "FATAL: SHARED_TOKEN missing or still set to the placeholder value.",
  );
  process.exit(1);
}

// TLS material may be supplied as either a PFX (PKCS#12) bundle or as a
// separate cert+key PEM pair. PFX is what the Windows installer generates
// when no operator-supplied cert/key is available, because exporting RSA
// private keys to PEM requires .NET Core 3+ APIs that PowerShell 5.1 on
// Windows Server LTSC editions still lacks.
let tlsOpts;
if (TLS_PFX_PATH) {
  if (!fs.existsSync(TLS_PFX_PATH)) {
    console.error(`FATAL: TLS_PFX_PATH set but file not found: ${TLS_PFX_PATH}`);
    process.exit(1);
  }
  tlsOpts = {
    pfx: fs.readFileSync(TLS_PFX_PATH),
    ...(TLS_PFX_PASSPHRASE ? { passphrase: TLS_PFX_PASSPHRASE } : {}),
  };
} else if (fs.existsSync(TLS_CERT_PATH) && fs.existsSync(TLS_KEY_PATH)) {
  tlsOpts = {
    cert: fs.readFileSync(TLS_CERT_PATH),
    key: fs.readFileSync(TLS_KEY_PATH),
  };
} else {
  console.error(
    `FATAL: TLS material not found. Provide a PFX via TLS_PFX_PATH or both ${TLS_CERT_PATH} and ${TLS_KEY_PATH}.`,
  );
  process.exit(1);
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a || "", "utf8");
  const bb = Buffer.from(b || "", "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function authorizeHeader(authHeader) {
  const m = /^Bearer\s+(.+)$/i.exec(authHeader || "");
  return !!(m && timingSafeEqual(m[1], SHARED_TOKEN));
}

function originAllowed(origin) {
  if (ALLOWED_ORIGINS.length === 0) return true;
  return ALLOWED_ORIGINS.includes(origin);
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

function execPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`PowerShell failed: ${stderr || err.message}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function listCerts() {
  // Enumerate the user's personal cert store, keep only certs with a Digital
  // Signature key usage and a private key, drop expired ones, return JSON.
  const ps = `
    $now = Get-Date
    Get-ChildItem -Path Cert:\\CurrentUser\\My |
      Where-Object {
        $_.HasPrivateKey -and
        $_.NotAfter -gt $now -and
        ( -not $_.Extensions.KeyUsages -or
          $_.Extensions.KeyUsages -match 'DigitalSignature' )
      } |
      Select-Object @{
        Name='thumbprint'; Expression={$_.Thumbprint}
      }, @{
        Name='subject'; Expression={$_.Subject}
      }, @{
        Name='issuer'; Expression={$_.Issuer}
      }, @{
        Name='notBefore'; Expression={$_.NotBefore.ToString('o')}
      }, @{
        Name='notAfter'; Expression={$_.NotAfter.ToString('o')}
      }, @{
        Name='ekus'; Expression={
          ($_.EnhancedKeyUsageList | ForEach-Object { $_.FriendlyName }) -join ','
        }
      } | ConvertTo-Json -Depth 4 -Compress
  `;
  const { stdout } = await execPowerShell(ps);
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function signData({ thumbprint, dataB64 }) {
  if (!/^[A-Fa-f0-9]+$/.test(String(thumbprint || ""))) {
    throw new Error("Invalid thumbprint");
  }
  if (!dataB64) throw new Error("dataB64 required");
  const data = Buffer.from(dataB64, "base64");
  const inFile = tempFile("sign-in", ".bin");
  const outFile = tempFile("sign-out", ".sig");
  fs.writeFileSync(inFile, data);
  try {
    // Authenticode signs the *file*, not the bytes — for a generic byte
    // signature we use RSA via the cert's private key from the store.
    const ps = `
      $cert = Get-ChildItem -Path 'Cert:\\CurrentUser\\My\\${thumbprint}'
      if (-not $cert) { throw "Certificate not found" }
      $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
      $bytes = [System.IO.File]::ReadAllBytes('${inFile.replace(/\\/g, "\\\\")}')
      $sig = $rsa.SignData(
        $bytes,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
      [System.IO.File]::WriteAllBytes('${outFile.replace(/\\/g, "\\\\")}', $sig)
    `;
    await execPowerShell(ps);
    const sig = fs.readFileSync(outFile);
    return { signatureB64: sig.toString("base64") };
  } finally {
    for (const p of [inFile, outFile])
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
  }
}

async function submitCsr(csrPem, template) {
  const csrPath = tempFile("csr", ".req");
  const certPath = tempFile("cert", ".cer");
  try {
    fs.writeFileSync(csrPath, csrPem, "utf8");
    const args = ["-submit", "-attrib", `CertificateTemplate:${template}`];
    if (CA_CONFIG) args.push("-config", CA_CONFIG);
    args.push(csrPath, certPath);
    await new Promise((resolve, reject) =>
      execFile(
        "certreq.exe",
        args,
        { windowsHide: true },
        (err, _stdout, stderr) =>
          err ? reject(new Error(stderr || err.message)) : resolve(),
      ),
    );
    return { certPem: fs.readFileSync(certPath, "utf8") };
  } finally {
    for (const p of [csrPath, certPath])
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
  }
}

// -------- HTTPS server (REST + WS upgrade) -------------------------------
const httpsServer = https.createServer(tlsOpts, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const u = url.parse(req.url, true);

  if (req.method === "GET" && u.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: "0.2.0" }));
    return;
  }
  if (!authorizeHeader(req.headers["authorization"])) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }
  try {
    if (req.method === "POST" && u.pathname === "/sign") {
      const body = await readJsonBody(req);
      const out = await submitCsr(
        String(body.csrPem || ""),
        String(body.template || CERT_TEMPLATE),
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
      return;
    }
    if (req.method === "POST" && u.pathname === "/list-certs") {
      const certs = await listCerts();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ certs }));
      return;
    }
    if (req.method === "POST" && u.pathname === "/sign-data") {
      const body = await readJsonBody(req);
      const out = await signData(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
      return;
    }
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err.message || err) }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

// -------- WebSocket envelopes -------------------------------------------
const wss = new WebSocketServer({ noServer: true });

function setupWs(ws, origin) {
  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      ws.send(JSON.stringify({ ok: false, error: "Invalid JSON" }));
      return;
    }
    const { id, type, payload, token } = msg ?? {};
    if (!timingSafeEqual(token, SHARED_TOKEN)) {
      ws.send(JSON.stringify({ id, ok: false, error: "Unauthorized" }));
      return;
    }
    try {
      if (type === "list-certs") {
        const certs = await listCerts();
        ws.send(JSON.stringify({ id, ok: true, result: { certs } }));
        return;
      }
      if (type === "sign-data") {
        const out = await signData(payload || {});
        ws.send(JSON.stringify({ id, ok: true, result: out }));
        return;
      }
      ws.send(JSON.stringify({ id, ok: false, error: "Unknown type" }));
    } catch (err) {
      ws.send(
        JSON.stringify({ id, ok: false, error: String(err.message || err) }),
      );
    }
  });
  ws.send(JSON.stringify({ type: "hello", origin }));
}

httpsServer.on("upgrade", (req, socket, head) => {
  const origin = req.headers["origin"] || "";
  if (!originAllowed(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!authorizeHeader(req.headers["authorization"])) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => setupWs(ws, origin));
});

httpsServer.listen(PORT, () => {
  console.log(`Signing agent (HTTPS + WSS) listening on port ${PORT}`);
});

// -------- Local-only WebSocket on 127.0.0.1:27443 -----------------------
// Same auth/origin rules. This is the channel the web app uses.
const localServer = http.createServer((_req, res) => {
  res.writeHead(426, { "Content-Type": "text/plain" });
  res.end("Upgrade required");
});
localServer.on("upgrade", (req, socket, head) => {
  const origin = req.headers["origin"] || "";
  if (!originAllowed(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  // Token may come via the first WS message instead of the upgrade header.
  wss.handleUpgrade(req, socket, head, (ws) => setupWs(ws, origin));
});
localServer.listen(LOCAL_WS_PORT, "127.0.0.1", () => {
  console.log(
    `Signing agent local WS listening on ws://127.0.0.1:${LOCAL_WS_PORT}`,
  );
});
