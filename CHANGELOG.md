# Changelog

## 3.0.0 — Major version release

- Updated the application, API, package metadata, and in-app version display
  to 3.0.0.

## 1.5.0 — Immutable audit trail

- Added an `ENABLE ALWAYS` PostgreSQL trigger that rejects direct updates,
  deletes, and truncation of `audit_log`, with fail-closed startup verification.
- Restricted audit-log replacement to the transactional restore path and added
  live PostgreSQL tests for trigger tampering, restore success, and rollback.
- Added automatic schema-to-backup coverage checks and documented CSRF,
  authentication lockouts, audit protection, and session-store exclusions.

## 1.4.0 — Operator-managed settings encryption

- Restored the production requirement for an independent
  `SETTINGS_ENCRYPTION_KEY` and moved new SMTP, LDAP, and AD FS secret values
  to the operator-keyed `scv3` envelope.
- Added automatic migration from the embedded-key `scv2` compatibility format
  and retained migration support for older `scv1` values.

## 1.3.0 — Deployment compatibility

- Added a deployment compatibility mode that does not require
  `SETTINGS_ENCRYPTION_KEY`; settings secrets use an embedded deterministic
  encryption key and therefore have reduced protection if both the database
  and application image are compromised.

## 1.2.0 — Security baseline remediation and delivery controls

- Added pull-request/push CI with Node 20, the pinned pnpm toolchain, frozen
  installs, typechecking, API/frontend tests, full builds, and Docker build
  validation.
- Added GHCR image publishing for `main` and version tags with lowercase
  image names, immutable commit tags, OCI metadata, Buildx cache, and
  provenance/SBOM attestations where supported.
- Documented AD FS OIDC as the intended primary SSO path, scrypt local
  password hashing, externally managed CHdN PostgreSQL for production, local
  Compose PostgreSQL for development/test only, backup protection and
  retention responsibilities, and the default-admin change expectation.
- Marked the unreliable Kerberos/SPNEGO operator login path retired; AD FS
  OIDC is the supported SSO path.
- Added the project threat model and recorded the GHCR registry assumption.
