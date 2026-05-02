# Windows Certificate Signing Agent

A small Node.js HTTPS service that runs **on a Windows host with PowerShell access**
to your internal/Enterprise Certification Authority. The Purchasing Management
app POSTs a CSR (PEM) to this agent; the agent submits the request to the CA via
`certreq.exe` and returns the signed certificate (PEM). The same agent also
exposes a WebSocket transport that the web app uses to drive an in-browser
certificate picker (list certs in the Windows store / sign arbitrary bytes with
a private key that never leaves the host).

## Why a separate agent?

The main server runs in Docker on Linux. Active Directory Certificate Services
is reached most reliably from a domain-joined Windows host using the standard
`certreq` utility. Splitting the signer keeps the Linux container slim while
preserving Windows-native CA workflows.

## Endpoints

- `GET /healthz` — returns `{ ok: true, version }`
- `POST /sign` — body: `{ csrPem, template? }` → `{ certPem }`
- `POST /list-certs` → `{ certs: [...] }`
- `POST /sign-data` — body: `{ thumbprint, dataB64 }` → `{ signatureB64 }`
- WebSocket upgrade on the same TLS port (WSS), plus a plain `ws://`
  listener bound to `127.0.0.1:27443` for same-host browsers that cannot
  trust the agent's self-signed cert

The agent expects the API server's shared bearer token in the
`Authorization: Bearer <token>` header. WebSocket clients pass it as
`{ token }` in the first JSON message.

## Configuration

The agent reads `config.json` (path overridable via `CONFIG_PATH`) and falls
back to environment variables:

| Setting | Env var | Description | Default |
| --- | --- | --- | --- |
| `port` | `PORT` | HTTPS port to listen on | `9443` |
| `localWsPort` | `LOCAL_WS_PORT` | localhost-only WS port | `27443` |
| `tlsCertPath` | `TLS_CERT_PATH` | PEM cert (used if `tlsPfxPath` is unset) | `./agent.crt` |
| `tlsKeyPath` | `TLS_KEY_PATH` | PEM key (used if `tlsPfxPath` is unset) | `./agent.key` |
| `tlsPfxPath` | `TLS_PFX_PATH` | PKCS#12 bundle; takes precedence over PEM | _empty_ |
| `tlsPfxPassphrase` | `TLS_PFX_PASSPHRASE` | passphrase for the PFX | _empty_ |
| `sharedToken` | `SHARED_TOKEN` | Bearer token | _required_ |
| `certTemplate` | `CERT_TEMPLATE` | `certreq` template name | `WebServer` |
| `caConfig` | `CA_CONFIG` | optional `-config` for `certreq` | _empty_ |
| `allowedOrigins` | `ALLOWED_ORIGINS` (comma-list) | CORS / WS origin allow-list | _all_ |

Either a `tlsPfxPath` **or** the `tlsCertPath`+`tlsKeyPath` pair must be
present at start-up — the agent refuses to listen otherwise. PFX support
exists because PowerShell 5.1 on Windows Server LTSC editions cannot export
RSA private keys to PEM, so the installer ships a `.pfx` when it has to
generate a fallback self-signed cert.

## Packaged Windows installer (recommended)

A pre-built single-file installer lives under `installer/`. It bundles:

- a pinned Node.js LTS (Windows x64, `node.exe` only — no PATH pollution)
- [NSSM](https://nssm.cc/) for service management
- the agent source and its sole runtime dependency (`ws`)
- PowerShell setup/unsetup scripts that write `config.json`, ensure TLS
  material is in place (auto-generating a self-signed PFX when none is
  supplied), register the service, open the firewall, and verify the agent
  reaches the `Running` state before the installer reports success

### Install (operator)

```powershell
# Interactive — answers Welcome / License / Install dir prompts:
SigningAgent-Setup-0.2.0.exe

# Silent — supports any subset of switches; missing values are defaulted
# (token is auto-generated as a random 32-byte hex value, and a self-signed
# TLS PFX is generated if no /CERT and /KEY are supplied):
SigningAgent-Setup-0.2.0.exe /S `
    /TOKEN=0123456789abcdef... `
    /PORT=9443 `
    /CERT="C:\certs\agent.crt" `
    /KEY="C:\certs\agent.key" `
    /TEMPLATE=WebServer `
    /CACONFIG="dc01.corp.lan\Corp-Issuing-CA"
```

After install:

- Files live under `C:\Program Files\PurchasingSigningAgent\`.
- `config.json`, logs, and TLS material live under
  `C:\ProgramData\PurchasingSigningAgent\` (locked down to Administrators +
  SYSTEM).
- The Windows service `PurchasingSigningAgent` is registered via NSSM with
  auto start and **must reach `Running` for the installer to succeed**. If
  the service fails to start, the installer aborts, removes what it
  extracted, and reports the underlying PowerShell error so the operator can
  fix it (bad token, port conflict, missing `certreq.exe`, etc.) and retry.
- A Windows Firewall inbound TCP rule for the configured port is created.

If `/CERT` and `/KEY` are omitted the installer generates a 5-year
self-signed RSA-2048 PFX with SANs `<hostname>`, `<hostname>.<domain>`, and
`localhost`. Replace it before exposing the agent on a routable network —
either drop in `agent.crt`/`agent.key` (PEM) and restart the service, or
overwrite `agent.pfx` and update `tlsPfxPassphrase` in `config.json`.

### Uninstall

```powershell
# Add/Remove Programs → "Purchasing Signing Agent", or:
"C:\Program Files\PurchasingSigningAgent\Uninstall.exe"

# Silent — keeps the data directory:
"C:\Program Files\PurchasingSigningAgent\Uninstall.exe" /S
```

The uninstaller stops and removes the service, drops the firewall rule, and
removes the install directory. In interactive mode it asks before deleting
`C:\ProgramData\PurchasingSigningAgent`. Silent uninstall keeps the data
directory so you can re-install without losing config.

## Building the installer

The installer is built on Linux using [NSIS](https://nsis.sourceforge.io/),
so a Windows build host is **not** required. The build script downloads the
upstream Node.js Windows zip and the NSSM zip, extracts the binaries, runs
`npm install --omit=dev` for the agent's deps, compiles `installer.nsi`,
and Authenticode-signs the resulting EXE.

```bash
# Required tools on PATH: makensis, npm, curl, unzip, openssl, osslsigncode
cd tools/signing-agent/installer
./build.sh
# → dist/SigningAgent-Setup-0.2.0.exe (Authenticode-signed)
```

Useful environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `VERSION` | Version stamp (filename + version resource) | `0.2.0` |
| `NODE_VERSION` | Node.js LTS to bundle | `20.18.1` |
| `NODE_SHA256` | Pin SHA-256 of `node-*-win-x64.zip` (CI) | _unset_ |
| `NSSM_VERSION` | NSSM release to bundle | `2.24` |
| `NSSM_SHA256` | Pin SHA-256 of `nssm-*.zip` (CI) | _unset_ |
| `SIGN_PFX` | Path to a real Authenticode PFX (production) | _unset_ |
| `SIGN_PFX_PASS` | Password for `SIGN_PFX` | _unset_ |
| `SIGN_TIMESTAMP_URL` | RFC 3161 timestamp URL | `http://timestamp.sectigo.com` |
| `SIGN_PRODUCT_NAME` | Embedded Authenticode "name" | `Purchasing Signing Agent <ver>` |
| `SIGN_PRODUCT_URL` | Embedded Authenticode "more info" URL | _unset_ |
| `ALLOW_UNSIGNED=1` | Skip signing entirely (last resort) | _unset_ |

Signing is **not** optional. If `SIGN_PFX` is unset, `build.sh` generates
a self-signed test code-signing PFX in `installer/build-cache/` and signs
the EXE with that — so every artifact this build script produces is
Authenticode-signed and timestamped. Production releases must override
`SIGN_PFX` / `SIGN_PFX_PASS` with a real code-signing certificate so the
EXE survives SmartScreen, AppLocker, and Group Policy software-restriction
rules. Setting `ALLOW_UNSIGNED=1` is a deliberate escape hatch for local
development only.

Pinning `NODE_SHA256` / `NSSM_SHA256` is recommended in CI so the bundled
binaries are reproducible. The build leaves the staged files under
`installer/payload/` and downloads (plus the test code-signing PFX) under
`installer/build-cache/`; both are git-ignored.

## Manual install (no installer)

If you cannot use the installer, the legacy NSSM-by-hand path still works:

```powershell
# 1) Install Node.js LTS on the agent host and put NSSM on PATH.
# 2) Copy this folder to C:\purchasing-signing-agent.
cd C:\purchasing-signing-agent
npm install --omit=dev
# 3) Drop your TLS cert/key alongside index.js (or set TLS_CERT_PATH/TLS_KEY_PATH).
# 4) Edit config.json, then:
powershell -ExecutionPolicy Bypass -File install-service.ps1
```

To uninstall:

```powershell
powershell -ExecutionPolicy Bypass -File uninstall-service.ps1
```

Test from another machine:

```bash
curl -k -H "Authorization: Bearer $SHARED_TOKEN" https://signer.lan:9443/healthz
```

## Security notes

- Always run behind TLS — the agent refuses to start without a cert/key (or
  PFX) pair.
- Pick a `sharedToken` that is at least 32 random characters. The installer
  generates one for you when `/TOKEN=` is omitted.
- The agent never stores private keys for signing user data — it only
  forwards CSR text. For `sign-data`, the private key stays in the Windows
  certificate store; the agent shells out to PowerShell to perform the
  RSA-PKCS#1 signing operation.
- Limit network access to the agent's port via Windows Firewall. The
  installer opens the configured port for inbound TCP; tighten it with a
  remote IP scope via `netsh` after install if you want to restrict callers.
- `C:\ProgramData\PurchasingSigningAgent\` is ACL'd to Administrators +
  SYSTEM by the installer so only those principals can read the bearer
  token and the TLS PFX passphrase.
