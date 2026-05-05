import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  numeric,
  date,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ---------------- USERS ----------------
export const usersTable = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    passwordHash: text("password_hash"),
    source: text("source").notNull().default("LOCAL"),
    roles: text("roles").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("users_username_uniq").on(t.username)],
);
export type DbUser = typeof usersTable.$inferSelect;

// ---------------- DEPARTMENTS ----------------
export const departmentsTable = pgTable(
  "departments",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    code: text("code").notNull(),
    adGroupName: text("ad_group_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("departments_code_uniq").on(t.code)],
);
export type DbDepartment = typeof departmentsTable.$inferSelect;

export const userDepartmentsTable = pgTable(
  "user_departments",
  {
    userId: integer("user_id").notNull(),
    departmentId: integer("department_id").notNull(),
  },
  (t) => [uniqueIndex("user_dept_uniq").on(t.userId, t.departmentId)],
);

// ---------------- COMPANIES ----------------
export const companiesTable = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  address: text("address"),
  taxId: text("tax_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type DbCompany = typeof companiesTable.$inferSelect;

export const contactsTable = pgTable(
  "contacts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    role: text("role"),
  },
  (t) => [index("contacts_company_idx").on(t.companyId)],
);
export type DbContact = typeof contactsTable.$inferSelect;

// ---------------- WORKFLOWS ----------------
export const workflowsTable = pgTable(
  "workflows",
  {
    id: serial("id").primaryKey(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    departmentId: integer("department_id").notNull(),
    createdById: integer("created_by_id").notNull(),
    priority: text("priority").notNull().default("NORMAL"),
    currentStep: text("current_step").notNull().default("NEW"),
    branch: text("branch"),

    // Step 1
    description: text("description"),
    category: text("category"),
    estimatedAmount: numeric("estimated_amount"),
    currency: text("currency").default("EUR"),
    neededBy: date("needed_by"),

    // Step 2 - quotes
    quotes: jsonb("quotes").notNull().default([]),
    threeQuoteRequired: boolean("three_quote_required").notNull().default(false),
    // Publication tier derived from the first quote amount vs the
    // configured thresholds (settings.quoteThresholdStandard / LivreI /
    // LivreII). One of: STANDARD | THREE_QUOTES | LIVRE_I | LIVRE_II.
    // Nullable for back-compat with rows created before the tier
    // existed; for those, the UI falls back to threeQuoteRequired.
    publicationTier: text("publication_tier"),

    // Step 3 - manager
    managerApproved: boolean("manager_approved"),
    managerComment: text("manager_comment"),

    // Step 4 - financial
    financialApproved: boolean("financial_approved"),
    financialComment: text("financial_comment"),

    // GT Invest
    gtInvestDateId: integer("gt_invest_date_id"),
    gtInvestResultId: integer("gt_invest_result_id"),
    // Set when the GT Invest meeting this workflow belongs to has been
    // "prepared" (the merged PDF was sent to the recipients). Workflows
    // joined to a meeting *after* the prep ran will have this NULL,
    // which is the trigger for the UI to offer a re-notify.
    gtInvestPreparedAt: timestamp("gt_invest_prepared_at", { withTimezone: true }),
    // Fixed enum decision recorded by the GT Invest committee.
    // One of: OK, REFUSED, POSTPONED, ACCORD_PRINCIPE.
    // OK advances to ORDERING; REFUSED closes the workflow; POSTPONED
    // and ACCORD_PRINCIPE keep the workflow on GT_INVEST and require a
    // (re-)assigned meeting date.
    gtInvestDecision: text("gt_invest_decision"),
    gtInvestComment: text("gt_invest_comment"),

    // Step 5 - ordering
    orderNumber: text("order_number"),
    orderDate: date("order_date"),

    // Step 6 - delivery
    deliveredOn: date("delivered_on"),
    deliveryNotes: text("delivery_notes"),

    // Step 7 - invoice
    invoiceNumber: text("invoice_number"),
    invoiceAmount: numeric("invoice_amount"),
    invoiceDate: date("invoice_date"),

    // Step 8 - validating invoice
    invoiceValidated: boolean("invoice_validated"),
    invoiceSignedBy: text("invoice_signed_by"),
    invoiceSignedAt: timestamp("invoice_signed_at", { withTimezone: true }),

    // Step 9 - payment
    paymentDate: date("payment_date"),
    paymentReference: text("payment_reference"),

    // For undo
    previousStep: text("previous_step"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    lastStepChangeAt: timestamp("last_step_change_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Soft-delete marker. Admins "delete" workflows by setting this
    // timestamp; every list / detail / dashboard / export query filters
    // `deletedAt IS NULL` so deleted workflows simply disappear from
    // operational views. The Settings → Backup & Trash tab lets admins
    // restore them by clearing the column. The row (and its docs /
    // notes / history) is never physically removed unless the operator
    // explicitly purges from the database.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedById: integer("deleted_by_id"),
  },
  (t) => [
    uniqueIndex("workflows_reference_uniq").on(t.reference),
    index("workflows_dept_idx").on(t.departmentId),
    index("workflows_step_idx").on(t.currentStep),
    index("workflows_deleted_idx").on(t.deletedAt),
  ],
);
export type DbWorkflow = typeof workflowsTable.$inferSelect;

// ---------------- DOCUMENTS ----------------
export const documentsTable = pgTable(
  "documents",
  {
    id: serial("id").primaryKey(),
    workflowId: integer("workflow_id").notNull(),
    step: text("step").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    kind: text("kind").notNull(),
    version: integer("version").notNull().default(1),
    previousVersionId: integer("previous_version_id"),
    contentBase64: text("content_base64").notNull(),
    uploadedById: integer("uploaded_by_id").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    isCurrent: boolean("is_current").notNull().default(true),
  },
  (t) => [index("documents_workflow_idx").on(t.workflowId)],
);
export type DbDocument = typeof documentsTable.$inferSelect;

// ---------------- NOTES ----------------
export const notesTable = pgTable(
  "notes",
  {
    id: serial("id").primaryKey(),
    workflowId: integer("workflow_id").notNull(),
    step: text("step").notNull(),
    body: text("body").notNull(),
    authorId: integer("author_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notes_workflow_idx").on(t.workflowId)],
);
export type DbNote = typeof notesTable.$inferSelect;

// ---------------- HISTORY ----------------
export const historyTable = pgTable(
  "history",
  {
    id: serial("id").primaryKey(),
    workflowId: integer("workflow_id").notNull(),
    action: text("action").notNull(),
    fromStep: text("from_step"),
    toStep: text("to_step"),
    actorId: integer("actor_id").notNull(),
    details: text("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("history_workflow_idx").on(t.workflowId)],
);
export type DbHistory = typeof historyTable.$inferSelect;

// ---------------- AUDIT LOG ----------------
export const auditLogTable = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  actorId: integer("actor_id"),
  action: text("action").notNull(),
  target: text("target"),
  targetId: integer("target_id"),
  ip: text("ip"),
  details: text("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type DbAudit = typeof auditLogTable.$inferSelect;

// ---------------- SETTINGS (single row, key-value-ish) ----------------
export const settingsTable = pgTable("settings", {
  id: serial("id").primaryKey(),
  data: jsonb("data").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const gtInvestDatesTable = pgTable("gt_invest_dates", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  label: text("label"),
  // Last time the operator hit "Notify recipients now" for this meeting.
  // Null = never prepared. Updated again on every re-notify so the UI
  // shows the most recent send timestamp.
  preparedAt: timestamp("prepared_at", { withTimezone: true }),
  preparedById: integer("prepared_by_id"),
});
export type DbGtInvestDate = typeof gtInvestDatesTable.$inferSelect;

export const gtInvestResultsTable = pgTable("gt_invest_results", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
});
export type DbGtInvestResult = typeof gtInvestResultsTable.$inferSelect;

// ---------------- SESSIONS (express-session compatible) ----------------
export const sessionsTable = pgTable("sessions", {
  sid: text("sid").primaryKey(),
  sess: jsonb("sess").notNull(),
  expire: timestamp("expire", { withTimezone: true }).notNull(),
});

// ---------------- DOCUMENT VERSIONS ----------------
// `documentsTable` carries the current/latest revision of each document
// kind on a workflow. `documentVersionsTable` is the immutable archive of
// every uploaded revision (including the current one) so the audit trail
// and "see previous version" UI is always backed by real rows.
export const documentVersionsTable = pgTable(
  "document_versions",
  {
    id: serial("id").primaryKey(),
    documentId: integer("document_id").notNull(),
    workflowId: integer("workflow_id").notNull(),
    version: integer("version").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    contentBase64: text("content_base64").notNull(),
    uploadedById: integer("uploaded_by_id").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("doc_versions_doc_idx").on(t.documentId),
    index("doc_versions_workflow_idx").on(t.workflowId),
  ],
);
export type DbDocumentVersion = typeof documentVersionsTable.$inferSelect;

// ---------------- WORKFLOW STEPS ----------------
// Per-step ledger: one row each time a workflow enters a step. Records who
// completed it and when, what action was taken, and any free-form payload
// (e.g. the manager comment, the chosen branch). Used by the dashboard
// "average age per step" and the by-step kanban.
export const workflowStepsTable = pgTable(
  "workflow_steps",
  {
    id: serial("id").primaryKey(),
    workflowId: integer("workflow_id").notNull(),
    step: text("step").notNull(),
    enteredAt: timestamp("entered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    completedById: integer("completed_by_id"),
    action: text("action"),
    payload: jsonb("payload").notNull().default({}),
  },
  (t) => [
    index("wf_steps_workflow_idx").on(t.workflowId),
    index("wf_steps_step_idx").on(t.step),
  ],
);
export type DbWorkflowStep = typeof workflowStepsTable.$inferSelect;

// ---------------- NOTIFICATIONS ----------------
// Log of every notification fan-out. Captures the workflow + step that
// triggered it, the recipient list, the channel (email today, SMS/Teams
// later), and the delivery status so operators can audit failures.
export const notificationsTable = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    workflowId: integer("workflow_id").notNull(),
    step: text("step").notNull(),
    channel: text("channel").notNull().default("email"),
    recipients: text("recipients").array().notNull().default([]),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("PENDING"),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("notif_workflow_idx").on(t.workflowId),
    index("notif_status_idx").on(t.status),
  ],
);
export type DbNotification = typeof notificationsTable.$inferSelect;

// ---------------- TLS / CERT (single row) ----------------
export const tlsTable = pgTable("tls_state", {
  id: serial("id").primaryKey(),
  privateKeyPem: text("private_key_pem"),
  csrPem: text("csr_pem"),
  certPem: text("cert_pem"),
  chainPem: text("chain_pem"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
