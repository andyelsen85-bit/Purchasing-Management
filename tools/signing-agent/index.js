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
// When true, hardware-backed certs (smart cards, HSM tokens, redirected
// smart cards via RDP/VDI) are excluded from the certificate picker.
// Set to true if your signing certificates are software certs installed
// locally on the machine and you want to hide smart card certs.
const SOFTWARE_CERTS_ONLY = !!(
  process.env.SOFTWARE_CERTS_ONLY === "true" || cfg.softwareCertsOnly
);

if (!SHARED_TOKEN || SHARED_TOKEN === "REPLACE_WITH_AT_LEAST_32_RANDOM_CHARS") {
  console.error(
    "FATAL: SHARED_TOKEN missing or still set to the placeholder value.",
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
  // The service runs as LocalSystem which has an empty CurrentUser cert store.
  // We use WTSQueryUserToken to impersonate the interactive console user inside
  // this PowerShell process (thread impersonation applies to cert store and CNG
  // private-key access within the same process — no child-process boundary).
  // Falls back gracefully to LocalMachine\My if no WTS session exists.
  const ps = `
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public class PurchasingWtsList {
    [DllImport("Wtsapi32.dll", SetLastError=true)]
    public static extern bool WTSQueryUserToken(uint sessionId, ref IntPtr phToken);
    [DllImport("kernel32.dll")]
    public static extern uint WTSGetActiveConsoleSessionId();
}
'@
    $wts_sid = [PurchasingWtsList]::WTSGetActiveConsoleSessionId()
    $wts_tok = [IntPtr]::Zero
    $wts_ctx = $null
    if ($wts_sid -ne 0xFFFFFFFF) {
      try {
        if ([PurchasingWtsList]::WTSQueryUserToken($wts_sid, [ref]$wts_tok)) {
          $wts_ctx = [System.Security.Principal.WindowsIdentity]::new($wts_tok).Impersonate()
        }
      } catch { }
    }
    try {
      $now = Get-Date
      $seen = @{}
      $results = @()
      foreach ($loc in @('CurrentUser', 'LocalMachine')) {
        try {
          $st = [System.Security.Cryptography.X509Certificates.X509Store]::new(
            'My',
            [System.Security.Cryptography.X509Certificates.StoreLocation]$loc)
          $st.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
          foreach ($c in $st.Certificates) {
            if ($c.HasPrivateKey -and $c.NotAfter -gt $now -and -not $seen[$c.Thumbprint]) {
              ${SOFTWARE_CERTS_ONLY ? `$hwBacked = $false
              try {
                $pk = $c.PrivateKey
                if ($pk -ne $null -and $pk.GetType().Name -eq 'RSACryptoServiceProvider') {
                  $hwBacked = $pk.CspKeyContainerInfo.HardwareDevice
                }
              } catch {}
              if (-not $hwBacked) {
                try {
                  $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($c)
                  if ($rsa -ne $null) {
                    $prov = try { $rsa.Key.Provider.Provider } catch { '' }
                    if ($prov -like '*Smart Card*' -or $prov -like '*SC KSP*' -or $prov -like '*SmartCard*') { $hwBacked = $true }
                  }
                } catch {}
              }
              if ($hwBacked) { continue }` : ""}
              $seen[$c.Thumbprint] = $true
              $results += $c
            }
          }
          $st.Close()
        } catch { }
      }
      if ($results.Count -eq 0) { '[]' } else {
        $results | Select-Object @{
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
      }
    } finally {
      if ($wts_ctx) { $wts_ctx.Undo() }
    }
  `;
  const { stdout } = await execPowerShell(ps);
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === "[]") return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function signData({ thumbprint, dataB64 }) {
  if (!/^[A-Fa-f0-9]+$/.test(String(thumbprint || ""))) {
    throw new Error("Invalid thumbprint");
  }
  if (!dataB64) throw new Error("dataB64 required");
  const data = Buffer.from(dataB64, "base64");

  // inFile  — written by LocalSystem, granted world-read before spawning user proc
  // outFile — path only (NOT pre-created); the user process creates it so it is
  //           owned by the user and writeable by them inside C:\Windows\Temp
  const inFile = tempFile("sign-in", ".bin");
  const outFile = path.join(
    os.tmpdir(),
    `sign-out-${crypto.randomUUID().replace(/-/g, "")}.sig`,
  );
  fs.writeFileSync(inFile, data);

  try {
    const inEsc = inFile.replace(/\\/g, "\\\\");
    const outEsc = outFile.replace(/\\/g, "\\\\");

    // ── Inner script: runs as the INTERACTIVE USER via CreateProcessAsUser ──
    // The child process holds the user's PRIMARY token, so CNG key isolation,
    // CAPI, and every other crypto subsystem see them as the real user.
    // No impersonation involved — no RPC issues.
    // Inner script: produce a detached PKCS#7 SignedData (CMS) blob over
    // the input bytes using the operator's CurrentUser\My certificate.
    // The CMS includes the SHA-256 hash of the content as a signed
    // attribute and the whole certificate chain, which is exactly what
    // PAdES requires for Adobe Reader to validate the signature.
    const innerPs = [
      `$cert=$null`,
      `foreach($loc in @('CurrentUser','LocalMachine')){`,
      `  $c=Get-ChildItem -Path "Cert:\\$loc\\My\\${thumbprint}" -ErrorAction SilentlyContinue`,
      `  if($c){$cert=$c;break}`,
      `}`,
      `if(-not $cert){[Environment]::Exit(2)}`,
      `Add-Type -AssemblyName System.Security`,
      `$bytes=[IO.File]::ReadAllBytes('${inEsc}')`,
      `$ci=New-Object System.Security.Cryptography.Pkcs.ContentInfo (,$bytes)`,
      `$cms=New-Object System.Security.Cryptography.Pkcs.SignedCms ($ci,$true)`,
      `$signer=New-Object System.Security.Cryptography.Pkcs.CmsSigner ($cert)`,
      `$signer.IncludeOption=[System.Security.Cryptography.X509Certificates.X509IncludeOption]::WholeChain`,
      `$signer.DigestAlgorithm=New-Object System.Security.Cryptography.Oid '2.16.840.1.101.3.4.2.1'`,
      `try{$cms.ComputeSignature($signer,$true)}catch{`,
      `  try{$cms.ComputeSignature($signer,$false)}catch{[Environment]::Exit(3)}`,
      `}`,
      `$enc=$cms.Encode()`,
      `if(-not $enc -or $enc.Length -eq 0){[Environment]::Exit(4)}`,
      `[IO.File]::WriteAllBytes('${outEsc}',$enc)`,
    ].join("\r\n");

    // PowerShell -EncodedCommand expects UTF-16LE then base64
    const innerB64 = Buffer.from(innerPs, "utf16le").toString("base64");

    // ── Outer script: LocalSystem, spawns inner script as the interactive user ──
    //
    // STARTUPINFO layout on x64 (matches native STARTUPINFOW):
    //   int cb(4) + [4 pad] + IntPtr×3(24) + uint×8(32) + ushort×2(4) + [4 pad] + IntPtr×4(32) = 104 bytes
    const ps = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class PurchasingCPAU {
  [DllImport("Wtsapi32.dll",SetLastError=true)]
  public static extern bool WTSQueryUserToken(uint sid,ref IntPtr tok);
  [DllImport("kernel32.dll")]
  public static extern uint WTSGetActiveConsoleSessionId();
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
  public struct STARTUPINFO {
    public int    cb;
    public IntPtr lpReserved;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpDesktop;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpTitle;
    public uint dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags;
    public ushort wShowWindow,cbReserved2;
    public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess,hThread; public uint dwProcessId,dwThreadId;
  }
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  public static extern bool CreateProcessAsUser(
    IntPtr hToken, string lpApp, StringBuilder lpCmd,
    IntPtr lpPA, IntPtr lpTA, bool bInherit, uint dwFlags,
    IntPtr lpEnv, string lpDir,
    ref STARTUPINFO lpSI, out PROCESS_INFORMATION lpPI);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr h,out uint c);
}
'@
try {
  $acl = Get-Acl -Path '${inEsc}' -ErrorAction SilentlyContinue
  if ($acl) {
    $au = New-Object Security.Principal.SecurityIdentifier 'S-1-5-11'
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($au,'Read','Allow')))
    Set-Acl -Path '${inEsc}' -AclObject $acl -ErrorAction SilentlyContinue
  }
} catch {}
$wsid = [PurchasingCPAU]::WTSGetActiveConsoleSessionId()
if ($wsid -eq 0xFFFFFFFF) { throw 'No interactive Windows session found. Is a user logged in at the console?' }
$wtok = [IntPtr]::Zero
if (-not [PurchasingCPAU]::WTSQueryUserToken($wsid,[ref]$wtok)) {
  throw ('WTSQueryUserToken failed with Win32 error: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
}
try {
  $si = New-Object PurchasingCPAU+STARTUPINFO
  $si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si)
  $si.lpDesktop = "winsta0\\default"
  $pi = New-Object PurchasingCPAU+PROCESS_INFORMATION
  # Use full path to powershell.exe — CreateProcessAsUser does not use the
  # caller's PATH the same way CreateProcess does, so resolving by basename
  # alone fails with ERROR_INVALID_NAME (123).
  $psExe = Join-Path $env:windir "System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  if (-not (Test-Path $psExe)) { throw "powershell.exe not found at $psExe" }
  $cmdStr = "\`"$psExe\`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${innerB64}"
  # StringBuilder needs extra capacity — CreateProcessW may write a null
  # terminator into the command-line buffer to split program from args.
  $cmd = New-Object Text.StringBuilder $cmdStr, 32768
  # CREATE_NO_WINDOW (0x08000000) — child has no console (we are a service)
  # CREATE_UNICODE_ENVIRONMENT (0x00000400) — required even with NULL env on some configs
  # lpCurrentDirectory must be a valid, accessible directory; LocalSystem's
  # inherited cwd (config\systemprofile) is often unreachable for the target
  # user and triggers ERROR_INVALID_NAME 123.
  $cwdPath = Join-Path $env:windir "Temp"
  $ok = [PurchasingCPAU]::CreateProcessAsUser($wtok,$psExe,$cmd,[IntPtr]::Zero,[IntPtr]::Zero,$false,0x08000400,[IntPtr]::Zero,$cwdPath,[ref]$si,[ref]$pi)
  if (-not $ok) {
    $werr = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw ('CreateProcessAsUser failed (err=' + $werr + ', exe=' + $psExe + ', cwd=' + $cwdPath + ', cmdLen=' + $cmdStr.Length + ')')
  }
  [PurchasingCPAU]::WaitForSingleObject($pi.hProcess,30000) | Out-Null
  $ec = 0
  [PurchasingCPAU]::GetExitCodeProcess($pi.hProcess,[ref]$ec) | Out-Null
  [PurchasingCPAU]::CloseHandle($pi.hProcess) | Out-Null
  [PurchasingCPAU]::CloseHandle($pi.hThread)  | Out-Null
  if ($ec -eq 2) { throw 'Certificate ${thumbprint} not found in user certificate store' }
  if ($ec -eq 3) { throw 'No RSA private key accessible for certificate ${thumbprint}' }
  if ($ec -eq 4) { throw 'Signing produced no output for certificate ${thumbprint}' }
  if ($ec -ne 0) { throw ('Signing subprocess exited with code ' + $ec) }
  if (-not (Test-Path '${outEsc}')) { throw 'Signature file was not written by signing subprocess' }
} finally {
  [PurchasingCPAU]::CloseHandle($wtok)
}
`.trim();

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

// -------- HTTP server (REST + WS upgrade, loopback only) -----------------
// The agent binds to 127.0.0.1 only, so TLS on this port is unnecessary and
// would require browsers to trust a self-signed cert. Plain HTTP on loopback
// is the standard approach (Chrome/Firefox both treat localhost as a secure
// context, so ws:// and http:// are fully usable from https:// pages).

function setCorsHeaders(res, origin) {
  // Echo the requesting origin back so credentialed requests work.
  // Fall back to * for non-browser consumers (curl, Postman, etc.).
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function readRawBody(req, max = 32 * 1024 * 1024) {
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
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  const origin = req.headers["origin"] || "";
  setCorsHeaders(res, origin);
  res.setHeader("Cache-Control", "no-store");

  // Handle CORS pre-flight — browsers send this before any non-simple request.
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const u = url.parse(req.url, true);

  if (req.method === "GET" && u.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    // Expose the first 8 chars and total length of the loaded token so the
    // operator can verify the service picked up the right config.json without
    // revealing the full secret.
    res.end(JSON.stringify({
      ok: true,
      version: "0.2.0",
      tokenLen: SHARED_TOKEN.length,
      tokenPrefix: SHARED_TOKEN.slice(0, 8),
    }));
    return;
  }
  if (!authorizeHeader(req.headers["authorization"])) {
    // Include the lengths so the operator can spot token mismatches without
    // the full secret appearing in logs or responses.
    const authHeader = req.headers["authorization"] || "";
    const m = /^Bearer\s+(.+)$/i.exec(authHeader);
    const receivedLen = m ? m[1].length : 0;
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "Unauthorized",
      hint: `expected token length ${SHARED_TOKEN.length}, received ${receivedLen}`,
    }));
    return;
  }
  try {
    if (req.method === "POST" && u.pathname === "/sign") {
      // Accept any binary body (PDF, etc.), pick the first available
      // certificate from the operator's Windows personal store, sign the
      // body bytes with RSA-SHA256, and return the detached signature.
      const bodyBuf = await readRawBody(req);
      const certs = await listCerts();
      if (certs.length === 0) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No valid signing certificate found in Windows personal store." }));
        return;
      }
      const cert = certs[0];
      const out = await signData({
        thumbprint: cert.thumbprint,
        dataB64: bodyBuf.toString("base64"),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        signatureB64: out.signatureB64,
        thumbprint: cert.thumbprint,
        subject: cert.subject,
      }));
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
    if (req.method === "POST" && u.pathname === "/sign-csr") {
      // Legacy endpoint — submit a CSR to a corporate CA via certreq.exe.
      const body = await readJsonBody(req);
      const out = await submitCsr(
        String(body.csrPem || ""),
        String(body.template || CERT_TEMPLATE),
      );
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

httpServer.on("upgrade", (req, socket, head) => {
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

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`Signing agent (HTTP + WS, loopback) listening on 127.0.0.1:${PORT}`);
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
