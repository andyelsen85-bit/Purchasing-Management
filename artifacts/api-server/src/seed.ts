import {
  db,
  usersTable,
  departmentsTable,
  userDepartmentsTable,
  companiesTable,
  contactsTable,
  workflowsTable,
  historyTable,
  notesTable,
  gtInvestDatesTable,
  gtInvestResultsTable,
  settingsTable,
} from "@workspace/db";
import { hashPassword } from "./lib/auth";
import { logger } from "./lib/logger";

async function main() {
  const existingUsers = await db.select().from(usersTable);
  if (existingUsers.length > 0) {
    logger.info(
      { count: existingUsers.length },
      "Users already exist, skipping seed",
    );
    return;
  }

  // Departments
  const [it, ops] = await db
    .insert(departmentsTable)
    .values([
      { name: "Information Technology", code: "IT", adGroupName: "PUR_IT" },
      { name: "Operations", code: "OPS", adGroupName: "PUR_OPS" },
    ])
    .returning();

  // Users
  const adminHash = await hashPassword("admin");
  const userHash = await hashPassword("password");
  const [admin, alice, bob, gt] = await db
    .insert(usersTable)
    .values([
      {
        username: "admin",
        displayName: "System Administrator",
        email: "admin@example.com",
        passwordHash: adminHash,
        roles: ["ADMIN", "FINANCIAL_ALL"],
        source: "LOCAL",
      },
      {
        username: "alice",
        displayName: "Alice Martin",
        email: "alice@example.com",
        passwordHash: userHash,
        roles: ["DEPT_MANAGER"],
        source: "LOCAL",
      },
      {
        username: "bob",
        displayName: "Bob Johnson",
        email: "bob@example.com",
        passwordHash: userHash,
        roles: ["DEPT_USER"],
        source: "LOCAL",
      },
      {
        username: "gtinvest",
        displayName: "GT Invest Reviewer",
        email: "gt@example.com",
        passwordHash: userHash,
        roles: ["GT_INVEST"],
        source: "LOCAL",
      },
    ])
    .returning();

  await db.insert(userDepartmentsTable).values([
    { userId: alice.id, departmentId: it.id },
    { userId: bob.id, departmentId: it.id },
    { userId: bob.id, departmentId: ops.id },
  ]);

  // Companies
  const [acme, contoso] = await db
    .insert(companiesTable)
    .values([
      { name: "Acme Hardware", address: "1 Industrial Way", taxId: "FR12345" },
      { name: "Contoso Services", address: "42 Cloud Avenue", taxId: "FR67890" },
    ])
    .returning();
  await db.insert(contactsTable).values([
    { companyId: acme.id, name: "Sarah Lee", email: "sarah@acme.example", phone: "+33 1 23 45 67 89", role: "Sales" },
    { companyId: contoso.id, name: "John Doe", email: "john@contoso.example", phone: "+33 9 87 65 43 21", role: "Account Manager" },
  ]);

  // GT Invest dates / results
  const next = new Date();
  next.setMonth(next.getMonth() + 1);
  next.setDate(15);
  await db.insert(gtInvestDatesTable).values([
    { date: next.toISOString().slice(0, 10), label: "Monthly GT Invest" },
  ]);
  await db.insert(gtInvestResultsTable).values([
    { label: "Approved" },
    { label: "Rejected" },
    { label: "Postponed" },
    { label: "Approved with conditions" },
  ]);

  // Workflows
  const [wf1] = await db
    .insert(workflowsTable)
    .values({
      reference: "PO-2026-00001",
      title: "New developer laptops",
      departmentId: it.id,
      createdById: alice.id,
      priority: "NORMAL",
      currentStep: "QUOTATION",
      previousStep: "NEW",
      description: "10x developer workstations for new hires",
      category: "Hardware",
      estimatedAmount: "18500.00",
      currency: "EUR",
      threeQuoteRequired: true,
      quotes: [
        { companyId: acme.id, companyName: "Acme Hardware", amount: 18000, currency: "EUR", winning: false, notes: "Standard config" },
      ],
    })
    .returning();
  await db.insert(historyTable).values([
    { workflowId: wf1.id, action: "CREATE", toStep: "NEW", actorId: alice.id, details: "Created" },
    { workflowId: wf1.id, action: "ADVANCE", fromStep: "NEW", toStep: "QUOTATION", actorId: alice.id },
  ]);
  await db.insert(notesTable).values({
    workflowId: wf1.id, step: "QUOTATION", body: "Waiting on second quote from Contoso.", authorId: alice.id,
  });

  const [wf2] = await db
    .insert(workflowsTable)
    .values({
      reference: "PO-2026-00002",
      title: "Cloud platform renewal",
      departmentId: ops.id,
      createdById: bob.id,
      priority: "HIGH",
      currentStep: "GT_INVEST",
      previousStep: "VALIDATING_BY_FINANCIAL",
      branch: "GT_INVEST",
      description: "Annual cloud platform contract renewal",
      category: "Software",
      estimatedAmount: "45000.00",
      currency: "EUR",
      threeQuoteRequired: true,
      managerApproved: true,
      managerComment: "Critical for ops continuity",
      financialApproved: true,
      financialComment: "Budgeted; needs GT Invest sign-off given amount",
      quotes: [
        { companyId: contoso.id, companyName: "Contoso Services", amount: 45000, currency: "EUR", winning: true, notes: "Annual renewal" },
      ],
    })
    .returning();
  await db.insert(historyTable).values([
    { workflowId: wf2.id, action: "CREATE", toStep: "NEW", actorId: bob.id },
    { workflowId: wf2.id, action: "ADVANCE", fromStep: "NEW", toStep: "QUOTATION", actorId: bob.id },
    { workflowId: wf2.id, action: "ADVANCE", fromStep: "QUOTATION", toStep: "VALIDATING_QUOTE_FINANCIAL", actorId: bob.id },
    { workflowId: wf2.id, action: "ADVANCE", fromStep: "VALIDATING_QUOTE_FINANCIAL", toStep: "VALIDATING_BY_FINANCIAL", actorId: alice.id },
    { workflowId: wf2.id, action: "ADVANCE", fromStep: "VALIDATING_BY_FINANCIAL", toStep: "GT_INVEST", actorId: admin.id, details: "branch=GT_INVEST" },
  ]);

  // Default settings
  const [existingSettings] = await db.select().from(settingsTable).limit(1);
  if (!existingSettings) {
    await db.insert(settingsTable).values({
      data: {
        appName: "Purchasing Management",
        currency: "EUR",
        limitX: 10000,
        gtInvestRecipients: [],
        certSigningEnabled: false,
        ldap: { enabled: false },
        smtp: { enabled: false },
      },
    });
  }

  logger.info(
    { admin: admin.id, alice: alice.id, bob: bob.id, gt: gt.id, wf1: wf1.id, wf2: wf2.id },
    "Seed complete",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: String(err) }, "Seed failed");
    process.exit(1);
  });
