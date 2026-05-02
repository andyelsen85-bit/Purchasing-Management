# Windows Certificate Signing Agent

A small Node.js HTTPS service that runs **on a Windows host with PowerShell access**
to your internal/Enterprise Certification Authority. The Purchasing Management
app POSTs a CSR (PEM) to this agent; the agent submits the request to the CA via
`certreq.exe` and returns the signed certificate (PEM).

## Why a separate agent?

The main server runs in Docker on Linux. Active Directory Certificate Services
is reached most reliably from a domain-joined Windows host using the standard
`certreq` utility. Splitting the signer keeps the Linux container slim while
preserving Windows-native CA workflows.

## Endpoints

- `GET /healthz` — returns `{ ok: true }`
- `POST /sign` — body: `{ csrPem: string, template?: string }`
  - returns `{ certPem: string, chainPem?: string }`

The agent expects the API server's shared bearer token in the
`Authorization: Bearer <token>` header. Configure the same value in the
Purchasing Management settings page.

## Configuration (environment variables)

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | HTTPS port to listen on | `9443` |
| `TLS_CERT_PATH` | Path to PEM cert | `./agent.crt` |
| `TLS_KEY_PATH` | Path to PEM key | `./agent.key` |
| `SHARED_TOKEN` | Bearer token required from clients | _required_ |
| `CERT_TEMPLATE` | Default `certreq` template name | `WebServer` |
| `CA_CONFIG` | Optional `-config` for `certreq` (e.g. `dc01\my-ca`) | _empty_ |

## Install & run as a Windows service

```powershell
# 1) Install Node.js LTS on the agent host
# 2) Copy this folder, then:
cd C:\purchasing-signing-agent
npm install --omit=dev
# 3) Drop your TLS cert / key alongside index.js (or set TLS_CERT_PATH / TLS_KEY_PATH)
# 4) Use NSSM or sc.exe to register a service that runs:
#    "C:\Program Files\nodejs\node.exe" "C:\purchasing-signing-agent\index.js"
```

Test from another machine:

```bash
curl -k -H "Authorization: Bearer $SHARED_TOKEN" https://signer.lan:9443/healthz
```

## Security notes

- Always run behind TLS — the agent refuses to start without a cert/key pair.
- Pick a `SHARED_TOKEN` that is at least 32 random characters.
- The agent never stores private keys — it only forwards the CSR text.
- Limit network access to the agent's port via Windows Firewall.
