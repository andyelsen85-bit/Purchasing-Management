# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

---

## Purchasing Management — Full Specification

### Application Name
**Purchasing Management**

### Purpose
Internal web application to manage purchasing workflows from initial quote request through to payment. Full traceability of every step.

---

### Technical Stack & Infrastructure
- React + Vite frontend (`artifacts/purchasing-management/`) at preview path `/`
- Express 5 backend (`artifacts/api-server/`) at `/api`
- PostgreSQL + Drizzle ORM for persistence
- Docker + docker-compose for deployment
- HTTPS managed in-app: CSR generation, certificate import, ports 443 (HTTPS) / 80 (HTTP fallback)
- Windows local signing agent (separate Node.js `.exe`) for PKI certificate-based signing

---

### Authentication & Directory Integration
- Local user accounts + LDAPS/Active Directory users and nested groups
- CA/Issuer certificate import in admin area for LDAPS TLS validation
- Option to skip LDAPS certificate verification (toggle in settings)
- Kerberos SSO (silent login for domain-joined machines on Edge/Firefox) with LDAP login form fallback
- App URL must be added to browser Intranet Zone / trusted sites list for Kerberos to work

---

### Roles & Permissions

| Role | Scope | Capabilities |
|---|---|---|
| Admin | All departments | Full access, audit log, settings, user management, undo steps |
| Financial — All Departments | All departments | Validating by Financial, GT Invest, Ordering, undo steps, write all depts |
| Financial — Invoice | All departments | Upload invoices (Invoice step) |
| Financial — Payment | All departments | Payment step |
| Department Manager | Their department(s) | Validate quotes, validate invoices |
| Department Users | Their department(s) | Create workflows, Quotation step, Delivery step |
| GT Invest Group | All departments | Read-only, GT Invest preparation view in header |
| Read-Only — Department | Their department | View only |
| Read-Only — All Departments | All departments | View only |

- Users and groups assignable to departments in User Management
- Users assigned to a department see only that department's workflows
- Admins and All-Departments roles see all workflows regardless of department

---

### UI Layout

**Left Sidebar 1 — Departments**
- "All Departments" selected by default
- Search function within department list
- Resizable width (click and drag); width saved per user, restored on reconnect
- Department list managed in Settings (add, rename, remove)

**Left Sidebar 2 — Workflows**
- Shows workflows from selected department
- Per workflow: Quote Number, PO Number, Invoice Number, current step
- Filterable by current step
- Click to open workflow in main window

**Main Window**
- Full workflow progress bar at top; completed steps highlighted green
- Defaults to next active (incomplete) step form
- Completed steps selectable to view their details
- Each step has its own form (details below)

**Top Header**
- Global search across all fields on all forms
- GT Invest Preparation view (all-department access required)
- All Workflows by Step view
- Custom logo (top-left, upload in admin area)

---

### Workflow Steps

| # | Step Name | Who acts |
|---|---|---|
| 1 | New | Department Users (creators) |
| 2 | Quotation | Department Users |
| 3 | Validating Quote → Financial | Department Managers |
| 4 | Validating by Financial | Financial — All Departments |
| 4a | GT Invest | Financial — All Departments |
| 4b | (K Order → goes directly to Ordering) | |
| 5 | Ordering | Financial — All Departments |
| 6 | Delivery | Department Users |
| 7 | Invoice | Financial — Invoice |
| 8 | Validating Invoice | Department Managers |
| 9 | Payment | Financial — Payment |

#### Global Rule on All Steps
- **Save**: saves partial data, no mandatory fields enforced
- **Complete**: enforces all mandatory fields before advancing

---

### Form Details per Step

**Step 1 — New**
- Auto-generated: date, internal number
- Creator identity recorded (who opened the workflow)
- Priority level (Low / Normal / High / Urgent)
- Fields: Subject, Description, Quote Number, Price with VAT
- If price < Limit X (global threshold set in settings):
  - 1 reseller: company name, contact name, email, document upload (multiple)
- If price ≥ Limit X:
  - 3 reseller quotes required (same fields per quote: price with VAT, company, contact, email, documents)
  - Lowest price highlighted as suggestion
  - Cannot Complete without 3 quotes and 3 document sets

**Step 2 — Quotation**
- Passive waiting — workflow remains visible in sidebar list until quotes arrive
- Users upload quote documents when they physically arrive
- Same upload fields as New (1 or 3 quotes depending on price vs Limit X)
- No automatic reminders; visibility in list is the prompt

**Step 3 — Validating Quote → Financial**
- Read-only view of New/Quotation data
- If 3-quote model: dropdown to select winning quote (lowest price pre-suggested)
- "Validate" button to complete and move to Financial

**Step 4 — Validating by Financial**
- Shows selected quote + non-selected quotes (3-quote model)
- Choose path: "K Order" → proceeds to Ordering; "GT Invest" → proceeds to GT Invest step

**Step 4a — GT Invest**
- Select GT Invest meeting date (from settings list, shown as "January 31/01/2026")
- Result listbox (managed in settings): Approved / Refused / Postponed
- Approved → Complete → proceeds to Ordering
- Refused → ask reason → workflow closed
- Postponed → select next meeting date from list

**Step 5 — Ordering**
- Shows accepted quote details
- Fields: Purchase Order date, PO Number
- Attach PO document (from finance software)
- Option to email quote + PO to reseller contact (if email on file)

**Step 6 — Delivery**
- Import delivery note (document upload)
- Complete = mark as delivered

**Step 7 — Invoice**
- Fields: Invoice Number
- Import invoice document (scan or saved file)

**Step 8 — Validating Invoice**
- Read-only view: Quote, PO, Delivery, Invoice — all details and documents
- Validate → proceed to Payment
- Refuse → ask reason → status "Waiting For" (can be reopened: correct invoice uploaded → reassign validation)
- Optional: sign with Windows user certificate from local cert store (enable/disable in settings)

**Step 9 — Payment**
- Shows all previous step details
- Field: Payment date
- Complete = payment confirmed (no bank/financial details stored)

---

### Undo Step
- Available to Admins and Financial — All Departments
- Reverts workflow to previous step automatically
- Action recorded in audit trail

---

### Notifications (Email via SMTP)
- **Creator** notified on every step change on their workflow
- **Department Managers** notified when quote validation or invoice validation required
- **Financial — All Departments** notified when Validating by Financial or GT Invest turn arrives
- **Financial — Payment** notified when workflow reaches Payment step

---

### Dashboard (Home Screen)
- Count of workflows per step (clickable to filter)
- Average time a workflow spends per step
- Stalled/overdue workflows (no activity for configurable number of days)
- Recent activity feed
- Priority distribution

---

### GT Invest Preparation View (Top Header)
- Lists all workflows currently in GT Invest step
- Accessible to GT Invest Group and All-Departments roles
- Export as merged PDF:
  - Page 1: summary list (Department, Subject, Description, Price with VAT)
  - Followed by winning quote attachments per workflow in same order
  - All merged into one PDF
- Option to send merged PDF by email to recipients defined in settings
- PDF creation and merging done server-side (Node.js)

---

### All Workflows by Step View (Top Header)
- All workflows grouped and displayed by their current step

---

### Internal Notes per Step
- Discussion thread on each step
- Users leave internal notes; visible to authorised users on that workflow

---

### History & Audit
- **Step movement history**: full log of who moved each workflow and when
- **Document version history**: replaced documents kept with timestamp, previous versions accessible
- **Audit log**: all user actions (login, data changes) — stored in DB, hidden, visible to Admins only

---

### Workflow Age & Priority
- Visual indicator in sidebar showing how long a workflow has been in its current step
- Color coding: green (normal) / orange (aging) / red (overdue/stalled)
- Priority field on each workflow (Low / Normal / High / Urgent)

---

### Document Thumbnails
- Hover over any document thumbnail → show full-size preview inline

---

### Excel/CSV Export
- Export workflows filtered by department, step, date range
- Includes all key fields from all steps

---

### Settings Area
Manages:
- Users (local + LDAP assignment to departments and roles)
- LDAPS connection (host, port, base DN, bind credentials)
- CA/Issuer certificate upload for LDAPS TLS
- Departments (add, rename, remove)
- Reseller Companies (each company can have multiple contacts)
- Contacts (name, email, linked to company)
- Lists: GT Invest meeting dates, GT Invest result options
- Mail server (SMTP host, port, credentials, sender address)
- Limit X (global price threshold for single vs 3-quote model)
- Certificate signing toggle (enable/disable for Validating Invoice step)
- GT Invest PDF export email recipients
- Logo upload (top-left corner of app)

---

### HTTPS Management (Admin Area)
- Generate CSR (fill FQDN, Org, SANs → download .csr)
- Private key generated and stored server-side
- Import signed certificate (.crt + chain)
- Certificate dashboard: issuer, validity dates, SANs, fingerprint, expiry warning
- Re-key/renew at any time
- Port 443 = HTTPS; Port 80 = HTTP (redirects to HTTPS once cert installed)

---

### Windows Local Signing Agent
- Node.js app bundled as standalone `.exe`
- Runs as Windows Service (NSSM), auto-starts with Windows
- Local WebSocket on `localhost:27443`
- Origin restriction via `config.json` (`allowedOrigins` list)
- Silent install: `SigningAgent-Setup.exe /S`
- Certificate picker shown when multiple valid certs in Windows Personal store
- Expired certs hidden by default
- Used in: Validating Invoice step (when enabled in settings)

---

### Docker Deployment
- Dockerfile for the web app
- docker-compose for full stack (app + PostgreSQL)
- Environment variables configurable via `.env` file
