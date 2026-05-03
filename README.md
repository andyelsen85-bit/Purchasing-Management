# Purchasing Management

An internal, self-hosted full-stack web application that tracks every purchase
inside an organisation — from the first quote request all the way to the
final payment — with full traceability, role-based access, document
versioning, and complete audit logging.

> **Stack:** TypeScript end-to-end · React 19 + Vite + shadcn/ui · Express 5 ·
> PostgreSQL + Drizzle ORM · OpenAPI-first contract with Orval-generated
> React Query hooks · Docker Compose deployment · in-app HTTPS / certificate
> management · LDAPS + Kerberos SSO · Windows local signing agent.

---

## Table of contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Repository layout](#repository-layout)
4. [Tech stack](#tech-stack)
5. [Getting started](#getting-started)
6. [Configuration & environment](#configuration--environment)
7. [Database schema](#database-schema)
8. [REST API](#rest-api)
9. [Roles & permissions](#roles--permissions)
10. [Workflow lifecycle](#workflow-lifecycle)
11. [UI walkthrough](#ui-walkthrough)
12. [Notifications](#notifications)
13. [HTTPS & PKI](#https--pki)
14. [Authentication](#authentication)
15. [Windows Local Signing Agent](#windows-local-signing-agent)
16. [Backups, history & audit](#backups-history--audit)
17. [Deployment (Docker)](#deployment-docker)
18. [Development workflow](#development-workflow)
19. [Scripts reference](#scripts-reference)
20. [Contributing](#contributing)
21. [License](#license)

---

## Features

- **End-to-end purchasing workflow** — 9 sequential steps (New → Quotation →
  Validate Quote → Validate by Financial → optional GT Invest → Ordering →
  Delivery → Invoice → Validate Invoice → Payment).
- **Save vs. Complete model** — every step accepts partial saves; only
  `Complete / Next Step` enforces mandatory fields, and missing fields are
  highlighted inline (red border + red asterisk) instead of error popups.
- **Conditional quote logic** — single-quote model below a configurable
  price threshold (`Limit X`), 3-quote competitive bid above it, with the
  cheapest quote auto-suggested as the winner.
- **GT Invest committee flow** — workflows above threshold can be routed
  to a meeting date for Approve / Refuse / Postpone with merged-PDF export.
- **Full document lifecycle** — multi-upload per step, server-side
  thumbnails, hover-to-preview, version history (replaced files kept).
- **Role-based access** — 9 distinct roles, scoped per department, with
  read-only variants and an "All Departments" cross-cutting permission.
- **Department scoping** — sidebar lists, dashboards and exports are
  filtered to the departments the user belongs to.
- **LDAPS / Active Directory** integration with nested-group expansion,
  optional CA import, and Kerberos SSO fallback to a login form.
- **In-app HTTPS management** — generate CSR, import signed cert + chain,
  hot-reload TLS, expiry warnings — no shell access required.
- **Windows local signing agent** — optional standalone Node.js `.exe`
  installed as a Windows service that signs invoice validation actions
  with the user's PKI certificate from the Windows store.
- **Notifications** — SMTP email on relevant step transitions per role.
- **Dashboard** — counts per step, average time per step, stalled-workflow
  alerts, recent-activity feed, priority distribution.
- **Audit log** — every login, mutation and document change recorded;
  visible to admins only.
- **Excel/CSV + PDF export** — workflows by department/step/date range;
  per-workflow PDF export and merged GT Invest packs.
- **Soft-delete + restore** — deleted workflows recoverable from the
  recycle bin (admin-only).
- **Internal notes per step** — discussion thread scoped to each step.
- **Resizable, persisted UI** — sidebar widths stored per user.
- **In-app backup & restore** — admins can download a single self-
  contained JSON dump of every persisted table (documents included as
  base64) and restore it transactionally from the Settings page.

---

## Architecture

```
┌──────────────────────┐        ┌──────────────────────┐
│ React + Vite SPA     │ ──────▶│  Express 5 API       │
│ artifacts/           │  HTTPS │  artifacts/          │
│  purchasing-         │  /api  │  api-server          │
│  management          │◀────── │                      │
└──────────────────────┘        └─────────┬────────────┘
                                          │ Drizzle ORM
                                          ▼
                                ┌──────────────────────┐
                                │ PostgreSQL 16        │
                                └──────────────────────┘
```

- **Contract-first** — `lib/api-spec/openapi.yaml` is the single source of
  truth. `pnpm --filter @workspace/api-spec run codegen` runs Orval to
  regenerate:
  - `lib/api-zod/` — Zod schemas (used by Express to validate
    request/response bodies).
  - `lib/api-client-react/` — typed React Query hooks consumed by the
    SPA.
- **Single binary in production** — the API serves the built SPA as static
  files; one container, one port (80/443).
- **Persistent state** lives in three Docker volumes: `db-data` (Postgres),
  `app-uploads` (documents), `app-certs` (TLS material + private keys).

---

## Repository layout

```
.
├── artifacts/
│   ├── api-server/             # Express 5 backend (compiled with esbuild)
│   ├── purchasing-management/  # React + Vite SPA (shadcn/ui + Tailwind v4)
│   └── mockup-sandbox/         # Internal component preview server
├── lib/
│   ├── api-spec/               # OpenAPI YAML + Orval config
│   ├── api-zod/                # Generated Zod request/response schemas
│   ├── api-client-react/       # Generated React Query hooks
│   └── db/                     # Drizzle schema, migrations, push scripts
├── scripts/                    # Repo-wide utility scripts
├── docker/                     # Entrypoint + helpers used by the image
├── Dockerfile                  # Multi-stage build (Node 20 slim)
├── docker-compose.yml          # App + Postgres + named volumes
├── DEPLOY.md                   # Operator deployment guide
├── pnpm-workspace.yaml         # Workspace + version catalog
├── tsconfig.base.json          # Shared strict TS defaults
└── tsconfig.json               # Solution file (composite libs only)
```

Workspace conventions are documented in detail in `replit.md`.

---

## Tech stack

| Layer      | Choice                                                                |
| ---------- | --------------------------------------------------------------------- |
| Runtime    | Node.js 20 (production) · pnpm 10                                     |
| Language   | TypeScript 5.9 (strict, project references for libs)                  |
| Frontend   | React 19, Vite 7, Tailwind CSS v4, shadcn/ui, wouter (router), TanStack Query 5, Framer Motion, lucide-react |
| Backend    | Express 5, `express-session`, `passport`, `multer`, `nodemailer`, `pdf-lib`, `node-forge`, `ldapjs` |
| ORM        | Drizzle ORM, `drizzle-zod`, `drizzle-kit` (migrations)                |
| Database   | PostgreSQL 16                                                         |
| Validation | Zod (`zod/v4`) on both ends                                           |
| Codegen    | Orval 8 (React Query + Zod from OpenAPI)                              |
| Build      | esbuild (server CJS bundle), Vite (SPA)                               |
| Container  | Debian-slim multi-stage Docker build                                  |

---

## Getting started

### Prerequisites

- **Node.js 20+**
- **pnpm 10** (`corepack enable && corepack prepare pnpm@10.26.1 --activate`)
- **PostgreSQL 16** running locally _or_ Docker.

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure the database

Set `DATABASE_URL` in your shell or in a `.env` file at the repo root, then
push the schema:

```bash
export DATABASE_URL="postgres://user:pass@localhost:5432/purchasing"
pnpm --filter @workspace/db run push
```

### 3. Generate the API client (only after editing the OpenAPI spec)

```bash
pnpm --filter @workspace/api-spec run codegen
```

### 4. Run dev servers

```bash
# Terminal 1 — API
pnpm --filter @workspace/api-server run dev

# Terminal 2 — SPA (proxied to /api)
pnpm --filter @workspace/purchasing-management run dev
```

Default seed credentials (created on first boot):

- **username:** `admin`
- **password:** `admin`

Change the password immediately under **Settings → Users**.

---

## Configuration & environment

| Variable         | Required | Default | Purpose                                                                     |
| ---------------- | :------: | ------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`   | ✅       | —       | PostgreSQL connection string.                                               |
| `SESSION_SECRET` | ⚠️       | auto    | Cookie-session signing key. ≥32 chars. Auto-generated & persisted in Docker.|
| `PORT`           |          | `80`    | Plain HTTP port (also used for the HTTP→HTTPS redirect).                    |
| `HTTPS_PORT`     |          | `443`   | TLS port (active once a certificate has been imported in-app).              |
| `NODE_ENV`       |          | `production` in image | Toggles dev tooling.                                                |
| `WEB_DIST`       |          | `/app/web/dist` (image) | Path to the built SPA, served by the API.                              |
| `STATE_DIR`      |          | `/app/state` (image) | Where uploads, certs and the secret-file live.                          |

Runtime configuration (SMTP, LDAPS, Limit X, Logo, GT Invest recipients,
signing toggle) is **stored in the database** and managed entirely from the
**Settings** page — no environment variables required.

---

## Database schema

Tables (Drizzle, schema files in `lib/db/src/schema/`):

| Table                  | Purpose                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `users`                | Local + LDAP-mirrored accounts, role assignments, password hashes. |
| `departments`          | Department catalog.                                                |
| `user_departments`     | Many-to-many user ↔ department mapping.                            |
| `companies`            | Reseller / supplier companies.                                     |
| `contacts`             | Per-company contacts (name + email).                               |
| `workflows`            | The purchase request itself (state, priority, references, totals). |
| `workflow_steps`       | Per-step structured payload (quotes, PO data, invoice data, etc.). |
| `documents`            | File metadata, kind (`QUOTE`/`ORDER`/`INVOICE`/...), step linkage. |
| `document_versions`    | Replaced-file history (timestamps, who replaced).                  |
| `notes`                | Internal discussion threads scoped per workflow + step.            |
| `notifications`        | In-app notifications.                                              |
| `history`              | Step-movement log (who moved a workflow, when, why).               |
| `audit_log`            | Hidden security audit (logins, mutations); admin-only view.        |
| `gt_invest_dates`      | Catalog of meeting dates (label + date).                           |
| `gt_invest_results`    | Catalog of decision options.                                       |
| `settings`             | Singleton row holding all runtime configuration.                   |
| `sessions`             | `express-session` store.                                           |
| `tls_state`            | Generated CSRs, private keys (encrypted), imported chain.          |

Schema migrations are pushed with `pnpm --filter @workspace/db run push`
(use `push-force` to drop columns).

---

## REST API

The API is served under `/api` and described by `lib/api-spec/openapi.yaml`
(59 operations). Highlights, grouped by resource:

### Authentication
- `POST   /api/auth/login` — `login`
- `POST   /api/auth/logout` — `logout`
- `GET    /api/auth/session` — `getSession`
- `POST   /api/auth/kerberos` — `kerberosNegotiate`
- `POST   /api/auth/ldap/test` — `testLdap`

### Workflows
- `GET    /api/workflows` — `listWorkflows`
- `POST   /api/workflows` — `createWorkflow`
- `GET    /api/workflows/{id}` — `getWorkflow`
- `PATCH  /api/workflows/{id}` — `updateWorkflow`
- `DELETE /api/workflows/{id}` — `deleteWorkflow` (soft delete)
- `POST   /api/workflows/{id}/advance` — `advanceWorkflow`
- `POST   /api/workflows/{id}/reject` — `rejectWorkflow`
- `POST   /api/workflows/{id}/undo` — `undoWorkflow`
- `POST   /api/workflows/{id}/restore` — `restoreWorkflow`
- `GET    /api/workflows/by-step` — `listWorkflowsByStep`
- `GET    /api/workflows/deleted` — `listDeletedWorkflows`

### Documents
- `POST   /api/workflows/{id}/documents` — `uploadWorkflowDocument`
- `GET    /api/workflows/{id}/documents` — `listWorkflowDocuments`
- `DELETE /api/documents/{id}` — `deleteDocument`

### Notes & history
- `GET    /api/workflows/{id}/notes` — `listWorkflowNotes`
- `POST   /api/workflows/{id}/notes` — `createWorkflowNote`
- `GET    /api/workflows/{id}/history` — `listWorkflowHistory`

### GT Invest
- `GET    /api/gt-invest/workflows` — `listGtInvestWorkflows`
- `POST   /api/gt-invest/workflows/{id}/decision` — `setGtInvestDecision`
- `GET    /api/gt-invest/dates` — `listGtInvestDates`
- `POST   /api/gt-invest/dates` — `createGtInvestDate`
- `DELETE /api/gt-invest/dates/{id}` — `deleteGtInvestDate`
- `GET    /api/gt-invest/results` — `listGtInvestResults`
- `POST   /api/gt-invest/results` — `createGtInvestResult`
- `DELETE /api/gt-invest/results/{id}` — `deleteGtInvestResult`
- `GET    /api/gt-invest/export` — `exportGtInvestPackage` (merged PDF)

### Reference data
- `GET/POST/PATCH/DELETE /api/companies[/{id}]`
- `POST/PATCH/DELETE      /api/contacts[/{id}]`
- `GET/POST/PATCH/DELETE  /api/departments[/{id}]`
- `GET/POST/PATCH/DELETE  /api/users[/{id}]`

### Dashboard, exports, audit
- `GET    /api/dashboard/summary` — `getDashboardSummary`
- `GET    /api/exports/workflows.xlsx` — `exportWorkflows`
- `GET    /api/workflows/{id}/export.pdf` — `exportWorkflowPdf`
- `GET    /api/audit` — `listAuditLog` (admin only)
- `GET    /api/notifications` — `listNotifications`

### Settings & operations
- `GET    /api/settings` — `getSettings`
- `PATCH  /api/settings` — `updateSettings`
- `POST   /api/tls/csr` — `generateCsr`
- `POST   /api/tls/import` — `importCert`
- `POST   /api/tls/reload` — `reloadCert`
- `GET    /api/tls/info` — `getCertInfo`
- `GET    /api/health` — `healthCheck`
- `GET    /api/admin/backup` — full DB dump as JSON (admin-only).
- `POST   /api/admin/restore` — multipart upload of a backup JSON
  (admin-only); transactional truncate + re-seed; sequences bumped
  past restored ids; caller's session is destroyed on success.
- `POST   /api/admin/archive-attachments` — admin-only. Body
  `{ olderThanDays, dryRun? }`. Deletes the binary attachments
  (`documents` + `document_versions`) for every workflow whose
  `created_at` is older than the cutoff and writes one summary
  `audit_log` entry plus a per-workflow `history` row of action
  `ARCHIVE_ATTACHMENTS`. The workflow row, notes, history, audit
  trail and GT Invest data are preserved. Surfaced in the UI under
  Settings → Archive (preview + confirm + persisted default).

All operations are typed in the SPA via the generated React Query hooks
(`useListWorkflows`, `useAdvanceWorkflow`, `useSetGtInvestDecision`, …).

---

## Roles & permissions

| Role                          | Scope               | Capabilities                                                              |
| ----------------------------- | ------------------- | ------------------------------------------------------------------------- |
| Admin                         | All departments     | Full access, audit log, settings, user management, undo any step          |
| Financial — All Departments   | All departments     | Validating by Financial, GT Invest, Ordering, undo, write all departments |
| Financial — Invoice           | All departments     | Upload invoices on the Invoice step                                       |
| Financial — Payment           | All departments     | Mark payments on the Payment step                                         |
| Department Manager            | Their department(s) | Validate quotes, validate invoices                                        |
| Department User               | Their department(s) | Create workflows, run Quotation & Delivery steps                          |
| GT Invest Group               | All departments     | Read-only + GT Invest preparation overview                                |
| Read-Only — Department        | Their department    | View only                                                                 |
| Read-Only — All Departments   | All departments     | View only                                                                 |

Department membership is enforced server-side on every list/detail
endpoint.

---

## Workflow lifecycle

| #   | Step                          | Acts                       | Mandatory on Complete                                                |
| --- | ----------------------------- | -------------------------- | -------------------------------------------------------------------- |
| 1   | New                           | Department User (creator)  | subject, price, 1 or 3 quotes (depending on `Limit X`)               |
| 2   | Quotation                     | Department User            | quote documents uploaded; winning quote chosen if 3-quote model      |
| 3   | Validating Quote              | Department Manager         | Validate                                                             |
| 4   | Validating by Financial       | Financial — All Depts      | Choose path: K Order → Ordering, or GT Invest → step 4a              |
| 4a  | GT Invest                     | Financial — All Depts      | Decision (Approved / Refused / Postponed) + meeting date             |
| 5   | Ordering                      | Financial — All Depts      | PO number, PO date, PO document; optional email to reseller          |
| 6   | Delivery                      | Department User            | Delivery note document, delivered-on date                            |
| 7   | Invoice                       | Financial — Invoice        | Invoice number, amount, date, invoice document                       |
| 8   | Validating Invoice            | Department Manager         | Validate (or Refuse → "Waiting For"); optional PKI signature         |
| 9   | Payment                       | Financial — Payment        | Payment date                                                         |

`Complete` enforcement runs on the server (`validateAdvancePrereqs` in
`artifacts/api-server/src/routes/workflows.ts`); the client mirrors the
same checks in `artifacts/purchasing-management/src/lib/workflowValidation.ts`
to drive the inline red-asterisk highlighting.

**Undo** rewinds a workflow to the previous step, recording the action in
the audit log. Available to Admins and Financial — All Departments.

---

## UI walkthrough

- **Header** — global search, GT Invest queue shortcut, "Workflows by step"
  view, custom logo (uploaded in Settings).
- **Sidebar 1 — Departments** — search + click; resizable, width persisted
  per user; "All Departments" appears for cross-cutting roles.
- **Sidebar 2 — Workflows** — quote / PO / invoice numbers, current step
  badge, age indicator (green / orange / red), priority pill; filter by
  step.
- **Main pane**
  - Full-width step progress bar (completed steps green).
  - Defaults to the next active step's form.
  - Past steps are visitable in read-only mode.
  - Internal notes thread per step.
  - Document grid with hover thumbnails.
  - Missing required fields are surfaced inline (red ring + red `*`),
    never via popup.
- **Pages**
  - Dashboard (`/`)
  - Workflows by step (`/workflows-by-step`) — honours the active
    department picked in the sidebar (state is shared via a
    localStorage-backed `DepartmentFilter` context, so jumping
    between by-step view and a workflow detail keeps the same
    department selected).
  - Workflow detail (`/workflows/:id`)
  - GT Invest queue (`/gt-invest`)
  - Reseller (`/companies`) — sidebar label "Reseller"; the `/companies`
    route is preserved for backwards-compatible bookmarks and APIs.
  - Settings (`/settings`) — tabbed page covering App, Users,
    Departments, GT Invest catalogs, HTTPS, LDAP/Kerberos, SMTP,
    Signing agent, **Backup / Restore**, and **Audit Log** (the audit
    log is no longer a separate top-level page — admins reach it via
    the Settings → Audit tab).
  - Login (`/login`)

---

## Notifications

Email-only via the SMTP settings in the **Settings** page:

- **Creator** — every step change on a workflow they opened.
- **Department Managers** — when quote validation or invoice validation
  is required.
- **Financial — All Departments** — when Validating by Financial or GT
  Invest turn arrives.
- **Financial — Payment** — when a workflow reaches Payment.
- **GT Invest recipients** — merged-PDF export (when sent).

In-app notifications are also persisted (`notifications` table, exposed
via `GET /api/notifications`).

---

## HTTPS & PKI

Managed entirely from **Settings → HTTPS Management**:

1. **Generate CSR** — fill FQDN, organisation, SANs → download `.csr`.
   Private key is generated and stored encrypted in `tls_state`.
2. **Import certificate** — upload signed `.crt` + chain.
3. **Reload** — hot-reload TLS without restarting the container.
4. **Certificate dashboard** — issuer, validity, SANs, fingerprint,
   expiry warnings.

Until a certificate is imported, the app serves plain HTTP on `PORT`. Once
imported, `HTTPS_PORT` becomes active and HTTP traffic is redirected.

---

## Authentication

- **Local accounts** — bcrypt-hashed passwords stored in `users`.
- **LDAPS / Active Directory** — bind with service account, recursive
  group expansion, optional CA upload, optional skip-TLS-verify toggle.
- **Kerberos SSO** — silent login on domain-joined Edge / Firefox via
  SPNEGO; falls back to the LDAP login form on negotiation failure.
  Add the app URL to the browser's Intranet Zone / trusted sites for
  SSO to fire automatically.
- **Sessions** — `express-session` backed by Postgres (`sessions` table),
  signed with `SESSION_SECRET` (auto-generated and persisted in Docker if
  not provided).

---

## Windows Local Signing Agent

A standalone Node.js HTTPS service used by the **Validating Invoice**
step when PKI signing is enabled in Settings. Source lives in
`tools/signing-agent/` (outside the pnpm workspace — Windows-only).

**What it does**

- Runs as a Windows Service (`PurchasingSigningAgent`, registered via
  the bundled NSSM), auto-starts at boot.
- Listens on `https://<host>:<port>` (default port `9443`, configurable
  per host at install time and stored in **Settings → Signing Agent**)
  plus a local-only `ws://127.0.0.1:27443` for the in-browser cert
  picker.
- Reads certificates from the operator's Windows Personal store via
  PowerShell — private keys never leave the host. Expired certs are
  hidden by default; multiple matches surface a picker in the web UI.
- Endpoints (all behind a shared bearer token):
  - `GET  /healthz`
  - `POST /sign` — submit CSR PEM, returns issued cert via
    `certreq.exe` (Enterprise CA flow).
  - `POST /list-certs`
  - `POST /sign-data` — RSA-SHA256 signature with a chosen cert.

**Settings tie-in**

The Settings page exposes a "Use Windows signing agent" toggle plus an
**Agent port** number field (no URL — the agent only listens on each
operator's PC, so the URL is implicit `localhost:<port>`). The port is
persisted as `signingAgentPort` on the singleton settings row.

**Installer**

A pre-built single-file installer is produced from `tools/signing-agent/`
on Linux (no Windows VM required) using NSIS' cross-compiler:

```bash
cd tools/signing-agent/installer
./build.sh
# → dist/SigningAgent-Setup-<version>.exe (Authenticode-signed,
#   timestamped; ~18 MB; bundles a pinned Node.js + NSSM)
```

Required tools on the build host (already present in the Replit
environment): `makensis`, `npm`, `curl`, `unzip`, `openssl`,
`osslsigncode`. Set `SIGN_PFX` / `SIGN_PFX_PASS` for a real
code-signing cert; without them, the build self-generates a test PFX
and SmartScreen will reject the result on production hosts. Build
artefacts (`dist/`, `payload/`, `build-cache/`) are git-ignored.

**Operator install**

```powershell
# Interactive
SigningAgent-Setup-0.2.0.exe

# Silent — switches all optional; missing values are defaulted, and
# a self-signed TLS PFX + random 32-byte token are generated if absent.
SigningAgent-Setup-0.2.0.exe /S /TOKEN=<hex> /PORT=9443 `
  /CERT="C:\certs\agent.crt" /KEY="C:\certs\agent.key"
```

The installer writes config + TLS material to
`C:\ProgramData\PurchasingSigningAgent\` (ACL'd to Administrators +
SYSTEM), opens the firewall, and rolls back if the service does not
reach `Running`. See `tools/signing-agent/README.md` for the full
operator + build reference.

---

## Backups, history & audit

- **Step movement history** — `history` table; surfaced on every workflow
  detail page.
- **Document version history** — replacing a document keeps the previous
  file in `document_versions` with timestamps and uploader.
- **Audit log** — `audit_log` table; logins, mutations, undo, deletes,
  permission changes, plus `BACKUP` and `RESTORE` events. Admin-only
  view, accessed from **Settings → Audit Log**.
- **Soft-delete + restore** — deleting a workflow flags it; admins can
  restore it from `/api/workflows/deleted`.
- **In-app database backup & restore** — admin-only, served from
  Settings:
  - **`GET /api/admin/backup`** dumps every persisted table to one JSON
    file (`purchasing-backup-<iso-timestamp>.json`). Document blobs are
    already stored base64 in `documents` / `document_versions`, so the
    dump is fully self-contained — no separate uploads tarball.
    Tables included (17 of the 18 in the schema):

        users, departments, user_departments, companies, contacts,
        workflows, documents, document_versions, workflow_steps,
        notes, history, audit_log, settings, gt_invest_dates,
        gt_invest_results, notifications, tls_state

    `sessions` is intentionally excluded — it's transient and would
    expose other admins' cookies. The `settings` row is a JSONB column,
    so any new field added to `AppSettings` (e.g. `signingAgentPort`)
    is automatically captured without code changes.
  - **`POST /api/admin/restore`** uploads that JSON, validates the
    backup version up front, then in a single transaction
    `TRUNCATE … RESTART IDENTITY CASCADE`s all backed-up tables,
    streams the dump table-by-table back into Postgres in 1 000-row
    batches (under PG's 65 535 prepared-statement parameter cap),
    refuses partial dumps + unknown tables (so nothing is silently
    truncated), and finally bumps each serial sequence past the
    largest restored id. Sessions are also cleared so pre-restore
    cookies stop working, and the caller's own session is destroyed on
    success — every signed-in user must re-authenticate against the
    restored `users` table. Any failure mid-restore (validation,
    insert, or sequence bump) rolls the whole transaction back,
    leaving the previous data intact.
  - **10 GiB upload ceiling** on `/restore`. Multer streams the upload
    to a temp file under `os.tmpdir()/purchasing-restore/`, and
    `stream-json` parses it incrementally from disk — the dump is
    never materialised in memory, so multi-gigabyte snapshots no
    longer hit V8's ~512 MB string limit. The temp file is cleaned up
    in a `finally` block whether the restore succeeds or fails. Raise
    the cap via `TEN_GIB` in
    `artifacts/api-server/src/routes/backup.ts` if your snapshot
    grows past it; the real bottleneck at that point is host disk
    space, not the parser.
- **Volume-level backup** — for OS-level recovery the `db-data` Docker
  volume can still be snapshotted or `pg_dump`'d; see `DEPLOY.md`.

---

## Deployment (Docker)

The fastest path to production is `docker compose`:

```bash
# Optional: provide your own SESSION_SECRET (else it is auto-generated)
cp .env.example .env
# edit .env, set SESSION_SECRET to `openssl rand -hex 32`

docker compose up -d --build
```

The compose file ships:

- `db` — `postgres:16-alpine` with `pg_isready` healthcheck.
- `app` — multi-stage `Dockerfile` build that:
  1. Installs the workspace with `pnpm install --frozen-lockfile`.
  2. Builds composite libs (`tsc --build`).
  3. Bundles the API with esbuild and the SPA with Vite.
  4. Produces a self-contained runtime tree via `pnpm deploy`.
  5. On boot, runs `drizzle-kit push` to sync the schema, then starts
     the server.

Volumes:

| Volume        | Mounted at            | Purpose                                |
| ------------- | --------------------- | -------------------------------------- |
| `db-data`     | `/var/lib/postgresql` | PostgreSQL data dir.                   |
| `app-state`   | `/app/state`          | Session secret, runtime state.         |
| `app-uploads` | `/app/state/uploads`  | Uploaded documents.                    |
| `app-certs`   | `/app/state/certs`    | TLS material (private keys + chains).  |

Default seeded admin: `admin` / `admin` — **change immediately**.

See [`DEPLOY.md`](./DEPLOY.md) for the full operator guide and
troubleshooting notes.

---

## Development workflow

```bash
# Whole-repo typecheck (libs + leaf packages)
pnpm run typecheck

# Build everything
pnpm run build

# Regenerate API client + Zod schemas after editing openapi.yaml
pnpm --filter @workspace/api-spec run codegen

# Push DB schema in dev
pnpm --filter @workspace/db run push
pnpm --filter @workspace/db run push-force   # destructive

# Run a single artifact's dev server
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/purchasing-management run dev
```

Workspace conventions:

- Each package declares its own dependencies; nothing is shared
  implicitly.
- Use `"catalog:"` for any dependency already pinned in
  `pnpm-workspace.yaml`.
- Server code uses `req.log` / the singleton `logger` — never
  `console.log`.
- Cross-package contracts go through the OpenAPI spec; never hand-write
  HTTP calls.

---

## Scripts reference

Root scripts (`package.json`):

| Script             | Description                                        |
| ------------------ | -------------------------------------------------- |
| `typecheck`        | Build composite libs + typecheck every leaf pkg.   |
| `typecheck:libs`   | `tsc --build` for the composite libs only.         |
| `build`            | `typecheck` then `pnpm -r run build` everywhere.   |

Per-package scripts (selected):

| Package                              | Scripts                                |
| ------------------------------------ | -------------------------------------- |
| `@workspace/api-server`              | `dev`, `build`, `start`, `typecheck`   |
| `@workspace/purchasing-management`   | `dev`, `build`, `preview`, `typecheck` |
| `@workspace/api-spec`                | `codegen`                              |
| `@workspace/db`                      | `push`, `push-force`                   |

Helper scripts (`scripts/`):

| Script                         | Purpose                                            |
| ------------------------------ | -------------------------------------------------- |
| `scripts/setup-env.sh` / `.ps1`| Generate a `.env` with a strong `SESSION_SECRET`. |

---

## Contributing

1. Fork and create a feature branch.
2. Run `pnpm install`.
3. Make changes; if you touch the API contract, run
   `pnpm --filter @workspace/api-spec run codegen`.
4. Run `pnpm run typecheck`.
5. For DB changes, update `lib/db/src/schema/` and run `pnpm --filter
   @workspace/db run push` against a dev database.
6. Open a pull request.

---

## License

MIT — see [`LICENSE`](./LICENSE) (or the `license` field in `package.json`).
