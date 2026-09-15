# Threat Model

## Project Overview

Purchasing Management (InvestFlow) is an internal, self-hosted TypeScript
application for the complete purchasing lifecycle: an investment questionnaire
and request, quotes, financial and GT Invest approvals, an order, delivery,
invoice validation, and payment.  The React/Vite SPA is served by an Express 5
API.  Drizzle ORM persists business data in PostgreSQL; uploaded documents and
TLS material are kept in operator-managed filesystem volumes.  The application
also integrates with Microsoft AD FS (OIDC), LDAPS/Active Directory, SMTP, and
an optional Windows signing agent.

The client is untrusted.  The server is the authority for authentication,
department scoping, roles, workflow transitions, questionnaire completion,
quote rules, document access, and audit events.  Production is expected to use
an externally managed CHdN PostgreSQL service; the bundled PostgreSQL Compose
service is for local development and test only.

## Assets

- **Purchasing and investment records** -- the questionnaire, project and
  budget information, risk/data-classification answers, quotes, winning-quote
  decisions, orders, deliveries, invoices, payment dates, and internal notes.
  Unauthorized disclosure or alteration could cause financial loss or an
  invalid procurement decision.
- **Documents and signatures** -- quote, purchase-order, delivery, invoice,
  questionnaire attachments, document versions, generated PDFs, and invoice
  signatures.  These provide evidence for approvals and may contain personal,
  health, supplier, or commercially confidential information.
- **Accounts and sessions** -- local usernames and scrypt password hashes,
  AD/LDAP identities and group-derived roles, AD FS subject mappings, session
  cookies, CSRF state, and the administrator account.  Session compromise
  enables actions as the affected user.
- **Directory and identity configuration** -- AD FS issuer/client metadata,
  LDAP bind identity, CA certificates, group-to-role mappings, and department
  mappings.  These determine who can enter and what they can approve.
- **Secrets and cryptographic material** -- `SESSION_SECRET`,
  `SETTINGS_ENCRYPTION_KEY`, encrypted SMTP/LDAP/AD FS secrets, generated TLS
  private keys, certificate chains, and the signing-agent bearer token.
- **PostgreSQL data and audit evidence** -- users, sessions, settings,
  workflows, documents, history, audit logs, and notification status.  Audit
  records support accountability and must not be silently rewritten.
- **SMTP and notifications** -- SMTP credentials and recipient data, plus
  notification content.  A compromised SMTP configuration could disclose
  workflow information or impersonate the application.
- **Backups** -- the admin export contains database rows and document blobs as
  base64 inside an authenticated AES-256-GCM envelope (and excludes
  sessions).  It is a complete copy of the application data; its operator
  passphrase and retained files remain high-value secrets.

## Trust Boundaries

- **Browser/SPA to API** -- requests cross from an attacker-controlled browser
  to Express.  The API must not trust client-side role checks, workflow state,
  department IDs, filenames, or questionnaire completion.
- **Public to authenticated** -- health and bootstrap/configuration
  endpoints are reachable without a session; workflow, settings, document,
  export, and session data require authentication.  The authenticated session
  is represented by an HttpOnly, SameSite session cookie.
- **Authenticated user to administrator** -- user, settings, TLS/PKI,
  backup/restore, archive, LDAP testing, and audit surfaces are privileged.
  Role and department checks must be server-side on every route.
- **API to PostgreSQL** -- the API has broad database access through Drizzle.
  PostgreSQL is a separate service and its connection string, network policy,
  backups, patching, and access controls are deployment responsibilities.
- **API to AD FS and LDAP** -- identity claims, group membership, directory
  credentials, and CA trust cross into the application.  Issuer, audience,
  nonce, PKCE, TLS, and group-to-role mapping must be validated.
- **API to SMTP** -- email leaves the trusted application boundary.  SMTP TLS,
  recipient selection, and message content must be controlled; SMTP is not an
  authorization signal.
- **API to filesystem volumes** -- uploads, certificate/private-key state, and
  generated session state persist outside PostgreSQL.  They must not be served
  as arbitrary files and require filesystem permissions and encrypted storage
  where appropriate.
- **API to Windows signing agent** -- the optional remote HTTPS agent can use
  a user's Windows certificate store and sign data.  The bearer token, TLS
  endpoint, origin policy, certificate selection, and signed payload are a
  high-value boundary.
- **Application to backup destination** -- an admin downloading or exporting
  JSON crosses into an operator-controlled workstation, backup system, or
  object store.  The application does not by itself prove that an external
  destination encrypts, retains, or deletes the export.
- **Development/test to production** -- local Compose PostgreSQL and local
  secrets are not production controls.  Images and dependencies promoted to
  production must come from reviewed CI outputs.

## Scan Anchors

- **Production entry points:** `Dockerfile`, `docker/entrypoint.sh`,
  `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/app.ts`, and
  `artifacts/api-server/src/routes/index.ts`.
- **Highest-risk code:** `routes/auth.ts`, `middlewares/auth.ts`,
  `routes/workflows.ts`, `routes/documents.ts`, `routes/backup.ts`,
  `routes/settings.ts`, `routes/tls.ts`, `lib/secret-crypto.ts`,
  `lib/adfs.ts`, `lib/ldap.ts`, and signing-agent code under
  `tools/signing-agent/`.
- **Public surfaces:** `GET /api/healthz`,
  `/api/auth/login`, `/api/auth/setup-status`, `/api/auth/setup`,
  `/api/auth/public-config`, and AD FS start/callback routes.  Kerberos/SPNEGO
  is retired and `/api/auth/negotiate` is not a current application route.
- **Authenticated surfaces:** `/api/auth/session`,
  `/api/auth/change-password`, workflows, documents, notes, history, exports,
  companies, departments, notifications, and ordinary settings.
- **Admin or privileged surfaces:** users, settings mutation, TLS/PKI,
  audit, backup/restore, archive, LDAP tests, and service-signature
  administration.  Review every `requireRole(...)` call when adding routes.
- **Usually dev-only:** `artifacts/mockup-sandbox/`, local Compose PostgreSQL,
  generated frontend/client output, and installer build caches.  The Windows
  signing agent is separately deployed but is production-relevant when enabled.

## Threat Categories

### Spoofing

An attacker could steal or forge a session, abuse local credentials, exploit
an incorrectly configured AD FS callback, or impersonate a directory identity.
The application must create sessions only after successful local, LDAPS, or
validated AD FS authentication, rotate the session identifier on login, use
unpredictable session secrets, and validate AD FS issuer, audience, signature,
nonce, expiry, state, and PKCE.  Local passwords MUST remain scrypt hashes and
MUST never be logged.  Production operators MUST replace the seeded admin
credential before normal use and configure AD FS/LDAP deliberately.  The
signing agent MUST authenticate and use TLS; possession of its token is
equivalent to access to its signing capability.

### Tampering

Client-controlled department, role, workflow-step, quote winner, amount,
document metadata, and restore data could alter procurement decisions.  Every
mutation MUST validate its body with the API schemas, enforce authorization
and department scope server-side, and apply workflow/questionnaire rules on
the server.  SQL access MUST remain parameterized through Drizzle.  Document
replacement and invoice signatures MUST preserve version/history and bind a
signature to the intended payload.  Backup restore is destructive and MUST be
admin-only, transactional, format-validated, and followed by session
invalidation.

### Repudiation

Users could deny approving a quote, advancing a workflow, changing a role,
deleting a document, or restoring data.  Authentication, mutations, document
changes, permission changes, backup/restore, and workflow transitions MUST
produce audit/history records with actor, time, action, target, and useful
context.  PostgreSQL audit data and externally retained logs require
restricted write access, monitoring, and a retention policy; this document
does not claim that an external immutable log or SIEM is configured.

### Information Disclosure

Workflow records and attachments are confidential, and the backup JSON
contains nearly all persisted data.  All non-public API data MUST require a
valid session and be filtered by role and department.  Admin-only data
(including audit, settings secrets, TLS state, and backups) MUST never be
returned to ordinary users.  Uploaded files MUST remain outside the public
web root, use validated paths/types/size limits, and avoid secrets in logs.
Production traffic MUST use HTTPS, database transport and SMTP/LDAP TLS MUST
be configured, and `SETTINGS_ENCRYPTION_KEY` MUST be independently managed.
The backup download is an authenticated AES-256-GCM archive, but operators
MUST still protect its passphrase, use authenticated TLS, restrict access, and
apply encrypted external retention and deletion.

### Denial of Service

Unauthenticated login/setup, directory lookups, SMTP tests, PDF generation,
large document uploads, exports, and the 512 MiB (536,870,912-byte)
server-enforced restore path can consume
resources or trigger slow external services.  Deployment MUST put the service
behind an appropriate network edge and rate-limit authentication and
diagnostic endpoints.  Upload and request limits, streaming restore, bounded
timeouts, bounded PDF work, and cleanup of temporary files MUST be preserved.
PostgreSQL, SMTP, directory availability, disk capacity, and backup capacity
are operational dependencies; availability targets and alerting are not
verified by this repository.

### Elevation of Privilege

Broken object-level or function-level authorization could let a department
user read another department, validate an invoice, manage users, alter
settings, restore a database, or sign data.  Every protected route MUST use
server-side session and role checks, and workflow/detail/document queries MUST
enforce department scope rather than trusting IDs from the SPA.  Administrative
routes MUST remain inaccessible to merely authenticated users.  Restore files,
filenames, redirects, LDAP filters, certificate inputs, and signing requests
MUST be validated to prevent traversal, injection, SSRF, open redirects, or
arbitrary code execution.

## Required Guarantees

- AD FS OIDC is the intended primary SSO method; local accounts are the
  controlled break-glass path and LDAPS/AD is an explicitly configured
  directory integration.  Kerberos/SPNEGO is retired and MUST NOT be
  reintroduced as a production login path.
- A production process MUST fail closed without strong `SESSION_SECRET`,
  `SETTINGS_ENCRYPTION_KEY`, and a controlled `DATABASE_URL`; secrets MUST be
  supplied by deployment secret management, not committed files.
- SMTP, LDAP bind, and AD FS client secrets MUST use the versioned
  authenticated encryption in `lib/secret-crypto.ts` (AES-256-GCM with an
  independently managed 32-byte key); plaintext legacy values MUST be
  migrated and MUST not be exposed in production.
- All authenticated state-changing requests MUST have CSRF protection
  appropriate to the deployed client, in addition to same-origin/CORS
  controls.  This requirement must be verified in route tests; documentation
  alone is not evidence.
- Every route returning business data MUST enforce session, role, and
  department scope on the server.  Every workflow transition MUST enforce
  prerequisites server-side.
- Documents, certificate keys, signing tokens, backups, and database dumps
  MUST have least-privilege filesystem/network permissions and protected
  operator-managed retention.
- CI MUST run on pull requests and pushes, use the pinned pnpm toolchain and
  frozen lockfile, typecheck, run API and frontend tests, build the complete
  application, and validate the Docker image.  Published images MUST carry
  immutable commit tags and provenance/SBOM where supported.

## Accepted Risks

- Local-password break-glass access remains available because an organization
  can lose directory or AD FS connectivity.  It is accepted only with a
  strong unique password, forced first-use change, restricted admin access,
  monitoring, and prompt disablement when no longer needed.
- SMTP and directory integrations are external dependencies.  The application
  can validate configuration and TLS settings but cannot guarantee provider
  availability, provider-side retention, or provider-side compromise.
- The administrator-triggered encrypted backup/restore is intentionally
  powerful for recovery.  It is accepted only for trusted administrators and
  an access-controlled external backup process with passphrase handling.
- The optional Windows signing agent is an installation-specific trust
  boundary.  It is disabled unless the organization accepts its host,
  certificate-store, token, and code-signing operational responsibilities.
- Multi-factor authentication, immutable external audit storage, and database
  high-availability are deployment or organizational controls, not claimed by
  this application baseline.

## Operational Responsibilities

Operators must use AD FS as the reviewed primary SSO integration, keep
redirect URIs and claims scoped, and periodically review group-to-role and
department mappings.  They must provide a production PostgreSQL service with
network restrictions, encryption, patching, monitoring, tested backups, and
recovery objectives; the local Compose database does not satisfy those
requirements.

Operators must inject strong `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, and
`DATABASE_URL`.  Known deployment variables also include `NODE_ENV`,
`CORS_ORIGINS`, `PORT`, `HTTPS_PORT`, `WEB_DIST`, `STATE_DIR`, `UPLOADS_DIR`,
`CERTS_DIR`, and the documented `ADFS_*` OIDC variables.  SMTP/LDAP settings
are primarily administered in the application and must be protected in the
database.  They must import a trusted certificate, enforce HTTPS at the edge,
protect filesystem volumes, restrict admin access, rotate credentials, and
test restore and signing procedures.

Operators must establish backup retention and deletion of expired copies,
protect the operator-supplied backup passphrase, restrict downloaded backup
files, and avoid treating a base64 document blob as encryption outside the
authenticated backup envelope.  CI publishes
to GHCR using `GITHUB_TOKEN`; any Nexus mirror is an organization-managed
pull/tag/push process and is not configured or authenticated by this
repository.