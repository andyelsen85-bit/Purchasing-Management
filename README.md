# Purchasing Management

An internal, self-hosted full-stack web application that tracks every purchase
inside an organisation — from the first quote request all the way to the
final payment — with full traceability, role-based access, document
versioning, and complete audit logging.

> **UI language:** French throughout. The purchasing request entity is called
> **Commande** in the interface.

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
11. [Creation form — investment questionnaire](#creation-form--investment-questionnaire)
12. [UI walkthrough](#ui-walkthrough)
13. [Notifications](#notifications)
14. [HTTPS & PKI](#https--pki)
15. [Authentication](#authentication)
16. [Windows Local Signing Agent](#windows-local-signing-agent)
17. [Backups, history & audit](#backups-history--audit)
18. [Deployment (Docker)](#deployment-docker)
19. [Development workflow](#development-workflow)
20. [Scripts reference](#scripts-reference)
21. [Contributing](#contributing)
22. [License](#license)

---

## Features

- **End-to-end purchasing workflow** — 9 sequential steps (Nouvelle Demande →
  Devis → Validation Responsable → Validation Financière → optional GT Invest
  → Commande → Livraison → Facture → Validation Facture → Paiement).
- **Save vs. Complete model** — every step accepts partial saves; only
  `Étape suivante` enforces mandatory fields, highlighted inline (red border +
  red asterisk) instead of error popups.
- **Conditional quote logic** — single-quote model below a configurable price
  threshold (`Limite X`), 3-quote competitive bid above it, with the cheapest
  quote auto-suggested as the winner.
- **GT Invest committee flow** — workflows above threshold can be routed to a
  meeting date for Approuvé / Refusé / Reporté with merged-PDF export.
- **Investment questionnaire (11 sections)** — structured form attached to
  every new request; conditional fields (§4.4.1 only visible when §4.4 = Oui);
  auto-checked §11 document checklist (consumables offer when §8.2 = Oui,
  training offer when §10.1.1 = Oui).
- **Full document lifecycle** — multi-upload per step, server-side thumbnails,
  hover-to-preview, version history (replaced files kept).
- **Role-based access** — 9 distinct roles, scoped per department, with
  read-only variants and an "All Departments" cross-cutting permission.
- **Department scoping** — sidebar lists, dashboards and exports are filtered
  to the departments the user belongs to.
- **Inline master-data editing** — company general details (name, address,
  Tax ID / SIRET, notes) and department records (code, name) are editable
  directly in the Settings and Companies pages without leaving the page.
- **Currency always €** — all amounts are displayed and stored in euros;
  no per-quote currency selector.
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
- **Soft-delete + restore** — deleted requests recoverable from the recycle
  bin (admin-only).
- **Internal notes per step** — discussion thread scoped to each step.
- **Resizable, persisted UI** — sidebar widths stored per user.
- **In-app backup & restore** — admins can download a single self-contained
  JSON dump of every persisted table (documents included as base64) and
  restore it transactionally from the Settings page. Client-side and
  server-side size limit: **2 GiB**.

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
  - `lib/api-client-react/` — typed React Query hooks consumed by the SPA.
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
├── Dockerfile                  # Multi-stage build (Node 24 slim)
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
| Runtime    | Node.js 24 (production) · pnpm 10                                     |
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

- **Node.js 24+**
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

Change the password immediately under **Paramètres → Utilisateurs**.

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

Runtime configuration (SMTP, LDAPS, Limite X, Logo, GT Invest recipients,
signing toggle) is **stored in the database** and managed entirely from the
**Paramètres** page — no environment variables required.

---

## Database schema

Tables (Drizzle, schema file: `lib/db/src/schema/index.ts`):

| Table                  | Purpose                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `users`                | Local + LDAP-mirrored accounts, role assignments, password hashes. |
| `departments`          | Department catalog (code + name).                                  |
| `user_departments`     | Many-to-many user ↔ department mapping.                            |
| `companies`            | Reseller / supplier companies (name, address, taxId, notes).       |
| `contacts`             | Per-company contacts (name, email, phone, role).                   |
| `workflows`            | The purchase request (state, priority, references, investment form).|
| `workflow_steps`       | Per-step structured payload (quotes, PO data, invoice data, etc.). |
| `documents`            | File metadata, kind (`QUOTE`/`ORDER`/`INVOICE`/…), step linkage.  |
| `document_versions`    | Replaced-file history (timestamps, who replaced).                  |
| `notes`                | Internal discussion threads scoped per workflow + step.            |
| `notifications`        | Email notification log (recipients, status, errors).               |
| `history`              | Step-movement log (who moved a workflow, when, why).               |
| `audit_log`            | Hidden security audit (logins, mutations); admin-only view.        |
| `gt_invest_dates`      | Catalog of committee meeting dates (label + date).                 |
| `gt_invest_results`    | Catalog of committee decision options.                             |
| `settings`             | Singleton JSONB row holding all runtime configuration.             |
| `sessions`             | `express-session` store (excluded from backup).                    |
| `tls_state`            | Generated CSRs, private keys (encrypted), imported chain.          |

The `investmentForm` JSONB column on `workflows` stores the entire
11-section investment questionnaire, so new fields can be added without
schema migrations. The `settings.data` JSONB column likewise absorbs new
runtime configuration keys automatically.

Schema migrations are pushed with `pnpm --filter @workspace/db run push`
(use `push-force` to drop columns).

---

## REST API

The API is served under `/api` and described by `lib/api-spec/openapi.yaml`.
Highlights, grouped by resource:

### Authentication
- `POST   /api/auth/login` — `login`
- `POST   /api/auth/logout` — `logout`
- `GET    /api/auth/session` — `getSession`
- `POST   /api/auth/kerberos` — `kerberosNegotiate`
- `POST   /api/auth/ldap/test` — `testLdap`

### Workflows (Commandes)
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
- `POST   /api/admin/restore` — multipart upload of a backup JSON (admin-only);
  transactional truncate + re-seed; sequences bumped past restored ids;
  caller's session destroyed on success. **2 GiB upload ceiling.**
- `POST   /api/admin/archive-attachments` — admin-only. Body
  `{ olderThanDays, dryRun? }`. Deletes binary attachments for workflows
  older than the cutoff while preserving workflow rows, notes, history,
  audit trail, and GT Invest data.

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
| Department User               | Their department(s) | Create requests, run Quotation & Delivery steps                           |
| GT Invest Group               | All departments     | Read-only + GT Invest preparation overview                                |
| Read-Only — Department        | Their department    | View only                                                                 |
| Read-Only — All Departments   | All departments     | View only                                                                 |

Department membership is enforced server-side on every list/detail endpoint.

---

## Workflow lifecycle

| #   | Step (FR label)               | Acts                       | Mandatory on Complete                                                |
| --- | ----------------------------- | -------------------------- | -------------------------------------------------------------------- |
| 1   | Nouvelle Demande              | Department User (creator)  | Title, department, project leader, investment type, questionnaire §§1–11 |
| 2   | Devis                         | Department User            | Quote documents uploaded; winning quote chosen if 3-quote model      |
| 3   | Validation Responsable        | Department Manager         | Validate                                                             |
| 4   | Validation Financière         | Financial — All Depts      | Choose path: K Order → Ordering, or GT Invest → step 4a              |
| 4a  | GT Invest                     | Financial — All Depts      | Decision (Approuvé / Refusé / Reporté) + meeting date                |
| 5   | Commande                      | Financial — All Depts      | PO number, PO date, PO document; optional email to reseller          |
| 6   | Livraison                     | Department User            | Delivery note document, delivered-on date                            |
| 7   | Facture                       | Financial — Invoice        | Invoice number, amount, date, invoice document                       |
| 8   | Validation Facture            | Department Manager         | Validate (auto-advances to Paiement); or Refuse → "En attente"       |
| 9   | Paiement                      | Financial — Payment        | Payment date                                                         |

`Complete` enforcement runs on the server (`validateAdvancePrereqs` in
`artifacts/api-server/src/routes/workflows.ts`); the client mirrors the same
checks in `artifacts/purchasing-management/src/lib/workflowValidation.ts` to
drive the inline red-asterisk highlighting.

**Validate Invoice → auto-advance** — clicking Valider on step 8 saves the
validation then immediately advances the request to step 9 (Paiement) in a
single user action.

**Undo** rewinds a request to the previous step, recording the action in the
audit log. Available to Admins and Financial — All Departments.

---

## Creation form — investment questionnaire

The creation form (`/commandes/new`) captures a structured investment
questionnaire spread across 11 numbered sections stored as JSONB in
`workflows.investmentForm`. Key behaviours:

- **§4.4.1 — Position budgétaire** — the field and its dropdown are only
  shown and required when §4.4 ("Position budgétaire connue ?") = **Oui**.
  When §4.4 = Non the field is hidden and skipped by validation.
- **§8.2 → §11 auto-check** — selecting **Oui** for "Offre de prix des
  consommables jointe ?" (§8.2) automatically checks "Offre de prix des
  consommables" in the §11 document checklist.
- **§10.1.1 → §11 auto-check** — selecting **Oui** for "Offre de prix pour
  formation jointe ?" (§10.1.1) automatically checks "Offre de prix pour
  formation" in the §11 document checklist.
- **§11 — Documents obligatoires** — includes "Offre de prix pour formation"
  as a standard checklist item alongside the other required documents.
- All amounts are in **euros** (€); no currency selector is shown.

---

## UI walkthrough

> The entire interface is in **French**. Purchase requests are called
> **Commandes** throughout the UI.

- **Header** — global search, GT Invest queue shortcut, "Commandes par étape"
  view, custom logo (uploaded in Paramètres).
- **Sidebar 1 — Départements** — search + click; resizable, width persisted
  per user; "Tous les départements" appears for cross-cutting roles.
- **Sidebar 2 — Commandes** — quote / PO / invoice numbers, current step
  badge, age indicator (green / orange / red), priority pill; filter by step.
- **Main pane**
  - Full-width step progress bar (completed steps green).
  - Defaults to the next active step's form.
  - Past steps are visitable in read-only mode.
  - Internal notes thread per step.
  - Document grid with hover thumbnails.
  - Missing required fields surfaced inline (red ring + red `*`).
- **Sociétés (`/companies`)** — reseller/supplier list with inline editing:
  company general details (name, address, Tax ID / SIRET, notes) editable
  via the pencil icon; contacts added and edited inline. Edit/delete
  restricted to Admin and Financial — All Departments.
- **Pages**
  - Tableau de bord (`/`)
  - Commandes par étape (`/workflows-by-step`)
  - Détail commande (`/workflows/:id`)
  - GT Invest (`/gt-invest`)
  - Sociétés (`/companies`)
  - Paramètres (`/settings`) — tabbed page covering Application, Utilisateurs,
    Départements (inline edit code + name), GT Invest, HTTPS, LDAP/Kerberos,
    SMTP, Agent de signature, **Sauvegarde / Restauration**, and **Journal
    d'audit**.
  - Login (`/login`)

---

## Notifications

Email-only via the SMTP settings in **Paramètres**:

- **Creator** — every step change on a request they opened.
- **Department Managers** — when quote validation or invoice validation is
  required.
- **Financial — All Departments** — when Validating by Financial or GT Invest
  turn arrives.
- **Financial — Payment** — when a request reaches Paiement.
- **GT Invest recipients** — merged-PDF export (when sent).

In-app notifications are also persisted (`notifications` table, exposed via
`GET /api/notifications`).

---

## HTTPS & PKI

Managed entirely from **Paramètres → Gestion HTTPS**:

1. **Generate CSR** — fill FQDN, organisation, SANs → download `.csr`.
   Private key is generated and stored encrypted in `tls_state`.
2. **Import certificate** — upload signed `.crt` + chain.
3. **Reload** — hot-reload TLS without restarting the container.
4. **Certificate dashboard** — issuer, validity, SANs, fingerprint, expiry
   warnings.

Until a certificate is imported, the app serves plain HTTP on `PORT`. Once
imported, `HTTPS_PORT` becomes active and HTTP traffic is redirected.

---

## Authentication

- **Local accounts** — bcrypt-hashed passwords stored in `users`.
- **LDAPS / Active Directory** — bind with service account, recursive group
  expansion, optional CA upload, optional skip-TLS-verify toggle.
- **Kerberos SSO** — silent login on domain-joined Edge / Firefox via SPNEGO;
  falls back to the LDAP login form on negotiation failure. Add the app URL to
  the browser's Intranet Zone / trusted sites for SSO to fire automatically.
- **Sessions** — `express-session` backed by Postgres (`sessions` table),
  signed with `SESSION_SECRET` (auto-generated and persisted in Docker if not
  provided).

---

## Windows Local Signing Agent

A standalone Node.js HTTPS service used by the **Validation Facture** step
when PKI signing is enabled in Paramètres. Source lives in
`tools/signing-agent/` (outside the pnpm workspace — Windows-only).

**What it does**

- Runs as a Windows Service (`PurchasingSigningAgent`, registered via the
  bundled NSSM), auto-starts at boot.
- Listens on `https://<host>:<port>` (default port `9443`, configurable per
  host at install time and stored in **Paramètres → Agent de signature**) plus
  a local-only `ws://127.0.0.1:27443` for the in-browser cert picker.
- Reads certificates from the operator's Windows Personal store via
  PowerShell — private keys never leave the host. Expired certs are hidden by
  default; multiple matches surface a picker in the web UI.
- Endpoints (all behind a shared bearer token):
  - `GET  /healthz`
  - `POST /sign` — submit CSR PEM, returns issued cert via `certreq.exe`
    (Enterprise CA flow).
  - `POST /list-certs`
  - `POST /sign-data` — RSA-SHA256 signature with a chosen cert.

**Settings tie-in**

The Paramètres page exposes a "Utiliser l'agent de signature Windows" toggle
plus an **Agent port** number field. The port is persisted as
`signingAgentPort` on the singleton settings row.

**Installer**

A pre-built single-file installer is produced from `tools/signing-agent/` on
Linux (no Windows VM required) using NSIS' cross-compiler:

```bash
cd tools/signing-agent/installer
./build.sh
# → dist/SigningAgent-Setup-<version>.exe (~18 MB; bundles a pinned Node.js + NSSM)
```

Required tools on the build host: `makensis`, `npm`, `curl`, `unzip`,
`openssl`, `osslsigncode`. Set `SIGN_PFX` / `SIGN_PFX_PASS` for a real
code-signing cert; without them the build self-generates a test PFX and
SmartScreen will reject the result on production hosts.

**Operator install**

```powershell
# Interactive
SigningAgent-Setup-0.2.0.exe

# Silent
SigningAgent-Setup-0.2.0.exe /S /TOKEN=<hex> /PORT=9443 `
  /CERT="C:\certs\agent.crt" /KEY="C:\certs\agent.key"
```

The installer writes config + TLS material to
`C:\ProgramData\PurchasingSigningAgent\` (ACL'd to Administrators + SYSTEM),
opens the firewall, and rolls back if the service does not reach `Running`.
See `tools/signing-agent/README.md` for the full operator + build reference.

---

## Backups, history & audit

- **Step movement history** — `history` table; surfaced on every request
  detail page.
- **Document version history** — replacing a document keeps the previous file
  in `document_versions` with timestamps and uploader.
- **Audit log** — `audit_log` table; logins, mutations, undo, deletes,
  permission changes, plus `BACKUP` and `RESTORE` events. Admin-only view,
  accessed from **Paramètres → Journal d'audit**.
- **Soft-delete + restore** — deleting a request flags it; admins can restore
  it from `/api/workflows/deleted`.
- **In-app database backup & restore** — admin-only, served from Paramètres →
  Sauvegarde & Restauration:
  - **`GET /api/admin/backup`** dumps every persisted table to one JSON file
    (`purchasing-backup-<iso-timestamp>.json`). Document blobs are stored
    base64 in `documents` / `document_versions`, so the dump is fully
    self-contained. Tables included (17 of 18 — `sessions` is excluded):

        users, departments, user_departments, companies, contacts,
        workflows, documents, document_versions, workflow_steps,
        notes, history, audit_log, settings, gt_invest_dates,
        gt_invest_results, notifications, tls_state

    All new form fields (e.g. `investmentForm` JSONB, company address/taxId/
    notes) are captured automatically because the backup uses
    `db.select().from(table)` — no code changes needed when columns or JSONB
    keys are added.

  - **`POST /api/admin/restore`** uploads that JSON, validates the backup
    version up front, then in a single transaction `TRUNCATE … RESTART
    IDENTITY CASCADE`s all backed-up tables, streams the dump table-by-table
    back into Postgres in 1 000-row batches, refuses partial dumps and unknown
    tables, and finally bumps each serial sequence past the largest restored
    id. Sessions are also cleared; the caller's own session is destroyed on
    success — every signed-in user must re-authenticate. Any failure rolls the
    whole transaction back, leaving the previous data intact.

  - **2 GiB size limit** — enforced both client-side (immediate feedback
    before upload begins, with a human-readable size indicator) and
    server-side (multer ceiling). Files are streamed to a temp directory
    under `os.tmpdir()/purchasing-restore/` and parsed incrementally with
    `stream-json`, so the JSON is never materialised in memory. The temp file
    is cleaned up in a `finally` block whether restore succeeds or fails.

- **Volume-level backup** — for OS-level recovery the `db-data` Docker volume
  can still be snapshotted or `pg_dump`'d; see `DEPLOY.md`.

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
  5. On boot, runs `drizzle-kit push` to sync the schema, then starts the
     server.

Volumes:

| Volume        | Mounted at            | Purpose                                |
| ------------- | --------------------- | -------------------------------------- |
| `db-data`     | `/var/lib/postgresql` | PostgreSQL data dir.                   |
| `app-state`   | `/app/state`          | Session secret, runtime state.         |
| `app-uploads` | `/app/state/uploads`  | Uploaded documents.                    |
| `app-certs`   | `/app/state/certs`    | TLS material (private keys + chains).  |

Default seeded admin: `admin` / `admin` — **change immediately**.

See [`DEPLOY.md`](./DEPLOY.md) for the full operator guide and troubleshooting
notes.

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

- Each package declares its own dependencies; nothing is shared implicitly.
- Use `"catalog:"` for any dependency already pinned in `pnpm-workspace.yaml`.
- Server code uses `req.log` / the singleton `logger` — never `console.log`.
- Cross-package contracts go through the OpenAPI spec; never hand-write HTTP
  calls.

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

| Script                          | Purpose                                            |
| ------------------------------- | -------------------------------------------------- |
| `scripts/setup-env.sh` / `.ps1` | Generate a `.env` with a strong `SESSION_SECRET`.  |

---

## Contributing

1. Fork and create a feature branch.
2. Run `pnpm install`.
3. Make changes; if you touch the API contract, run
   `pnpm --filter @workspace/api-spec run codegen`.
4. Run `pnpm run typecheck`.
5. For DB changes, update `lib/db/src/schema/index.ts` and run
   `pnpm --filter @workspace/db run push` against a dev database.
6. Open a pull request.

---

## License

MIT — see [`LICENSE`](./LICENSE) (or the `license` field in `package.json`).
