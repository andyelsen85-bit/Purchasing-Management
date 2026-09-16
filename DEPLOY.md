# Deploying with Docker

## Deployment target

The checked-in `docker-compose.yml` is a **development/test** stack. It
includes a disposable local PostgreSQL 16 container and must not be used as
the production database. Production uses the published application image and
CHdN's externally managed PostgreSQL service, including the organization's
network controls, monitoring, backups, retention, and recovery procedures.
Set `DATABASE_URL` to that service through the deployment secret manager.

The default CI/publishing destination is GHCR:
`ghcr.io/<lowercase-owner>/purchasing-management-app`. Pushes to `main` and version tags
publish branch/version tags and immutable `sha-<commit>` tags. See the README
for the organization-managed GHCR-to-Nexus mirror procedure; this repository
does not contain Nexus credentials or assume a Nexus hostname.

## 1. Session key handling

You can skip this step. By default the container's entrypoint generates a
cryptographically strong 64-character `SESSION_SECRET` on first boot and
persists it inside the `app-state` Docker volume
(`/app/state/session_secret`), so it survives restarts and rebuilds.

The state volume must be persistent. Losing it invalidates active sessions.
For multiple replicas, provide the same operator-managed `SESSION_SECRET` to
every replica instead of relying on per-container generation.

If you'd rather manage the session key yourself, create a `.env` file next to
`docker-compose.yml`:

**Using the helper scripts:**

```bash
bash scripts/setup-env.sh                                          # Linux / macOS / WSL
powershell -ExecutionPolicy Bypass -File scripts\setup-env.ps1     # Windows
```

**Or by hand:**

```bash
cp .env.example .env
# Then edit .env and replace both secrets with independent random values:
#   SESSION_SECRET=$(openssl rand -hex 32)
#   SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

Production requires `SETTINGS_ENCRYPTION_KEY` as exactly 32 random bytes
encoded as 64 hexadecimal characters (or a 32-byte base64/base64url value).
Keep it stable, independent from `SESSION_SECRET`, and supply it through the
deployment secret manager. On first startup, values written by the 1.3.0
embedded-key compatibility release are automatically migrated from `scv2` to
the operator-keyed `scv3` format.

Docker Compose automatically loads `.env` from the directory you run
`docker compose` in, so no extra flags are needed.

## 2. Build and start locally

```bash
docker compose up -d --build
```

This command starts the local/test PostgreSQL service. For production, pull a
reviewed immutable image tag and provide the external `DATABASE_URL` instead
of starting the Compose `db` service.

The app listens on:

- `http://<host>/` — plain HTTP (used until you import a TLS certificate)
- `https://<host>/` — once a cert has been imported via
  **Settings → HTTPS Management** in the web UI

## 3. First login

Default seed admin (change the password immediately in **Settings → Users**):

- username: `admin`
- password: `admin`

The application forces this seeded account through a password change before
other routes can be used. Complete that change immediately. The seeded
credential is only a bootstrap convenience; production administrators should
then use AD FS OIDC as the intended primary SSO method. Keep a uniquely
protected local admin only as a reviewed break-glass account.

## 4. Production secrets and security configuration

Provide these values through a secret manager or protected environment:

| Variable | Production expectation |
| --- | --- |
| `DATABASE_URL` | CHdN-managed PostgreSQL connection string; never the local Compose database. |
| `SESSION_SECRET` | Optional override: at least 32 random characters, unique per environment. Otherwise generated in `STATE_DIR`. |
| `SETTINGS_ENCRYPTION_KEY` | Required independent 32-byte key (64 hex characters recommended); keep stable and provide through the deployment secret manager. |
| `NODE_ENV` | `production`. |
| `CORS_ORIGINS` | Explicit origins when SPA and API are split; same-origin is preferred. |
| `PORT`, `HTTPS_PORT` | HTTP/HTTPS listener ports as required by the edge. |
| `STATE_DIR`, `UPLOADS_DIR`, `CERTS_DIR` | Persistent, least-privilege mounts for state, uploads, and TLS material. |

AD FS fallback variables (`ADFS_ENABLED`, `ADFS_ISSUER` or
`ADFS_AUTHORITY`, `ADFS_DISCOVERY_URL`, `ADFS_CLIENT_ID`,
`ADFS_CLIENT_SECRET`, `ADFS_REDIRECT_URI`, `ADFS_SCOPES`, claim names, and
`ADFS_CA_PEM`) are listed in `.env.example`. Persisted Settings values take
precedence. Register the exact callback documented in
[`docs/adfs-oidc.md`](./docs/adfs-oidc.md). SMTP and LDAP values are managed
in Settings and encrypted with `SETTINGS_ENCRYPTION_KEY`.

For upgrades from 1.3.0, provide the newly managed key and startup will migrate
embedded-key `scv2` values to `scv3`. For older installations with `scv1`
values, use the original settings key that encrypted those values; generating a
replacement first makes them undecryptable. If that original key is lost,
restore it from the protected deployment secret or backup before upgrading.

## 5. Backup retention and encryption

The admin backup export contains database rows and document blobs. The
application encrypts the export as an authenticated AES-256-GCM envelope; the
JSON/base64 representation is only the decrypted payload encoding. Protect the
operator passphrase, transfer exports only over authenticated TLS, and apply
any additional organization-approved external encryption before retention.
The server-enforced restore upload ceiling is **512 MiB (536,870,912 bytes)**;
the API rejects larger multipart files before restore processing.
Restrict access to authorized administrators, retain them for the
organization's approved recovery window, test restoration, and delete expired
copies (including temporary downloads). Production PostgreSQL backups must
follow CHdN's externally managed encrypted backup and retention policy; the
local `db-data` volume is not that policy.

## Troubleshooting

**Generated runtime keys change after a pod replacement**
The `/app/state` mount is not persistent. Mount a persistent volume at
`/app/state`, or provide an operator-managed `SESSION_SECRET` shared by all
replicas.

**`SESSION_SECRET must be at least 32 characters`**
The value in `.env` is too short or matches a known placeholder
(`change-me`, `dev-secret-change-me`, etc). Replace it with the output of
`openssl rand -hex 32`.

**`Settings encryption key is not configured`**
Add `SETTINGS_ENCRYPTION_KEY` through the deployment secret manager. Generate
32 random bytes as 64 hexadecimal characters with `openssl rand -hex 32`.
Keep it stable and do not reuse `SESSION_SECRET`.

**`Settings encryption key is invalid`**
The value is malformed, not exactly 32 decoded bytes, or reuses the session
secret. Generate a separate value with `openssl rand -hex 32`.

## Security policies

Production rejects LDAP `skipVerify` and plain LDAP. Prefer a trusted CA PEM
in Settings. A temporary exception requires
`LDAP_TLS_INSECURE_EXCEPTION_REASON` and a future
`LDAP_TLS_INSECURE_EXCEPTION_EXPIRES_AT`; it is audited and should be removed
when the incident ends.

Admin backups are AES-256-GCM envelopes with a random per-export salt and
nonce. The operator supplies a passphrase (minimum 12 characters); it is
never persisted or logged. Keep encrypted backup files under the
organisation's retention policy and destroy expired copies securely.
Production rejects old plaintext JSON restores unless a short-lived, audited
`BACKUP_LEGACY_EXCEPTION_REASON` plus future
`BACKUP_LEGACY_EXCEPTION_EXPIRES_AT` is deployed.
