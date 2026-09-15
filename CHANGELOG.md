# Changelog

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
