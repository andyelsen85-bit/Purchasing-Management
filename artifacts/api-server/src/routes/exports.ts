import { Router, type IRouter } from "express";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import {
  db,
  workflowsTable,
  departmentsTable,
  usersTable,
} from "@workspace/db";
import ExcelJS from "exceljs";
import { requireAuth, getUser } from "../middlewares/auth";
import { canSeeWorkflow } from "../lib/permissions";

const router: IRouter = Router();

/**
 * GET /workflows/export
 *   ?format=xlsx|csv     (default xlsx)
 *   &departmentId=N
 *   &step=...
 *   &from=YYYY-MM-DD
 *   &to=YYYY-MM-DD
 *
 * Returns the matching workflows as a binary Excel file or a text/csv stream.
 * Department-scoped users only see workflows in their department(s).
 */
router.get(
  "/workflows/export",
  requireAuth,
  async (req, res): Promise<void> => {
    const user = getUser(req);
    const format = (req.query.format as string | undefined) === "csv" ? "csv" : "xlsx";
    const conditions = [];
    const departmentId = req.query.departmentId
      ? Number(req.query.departmentId)
      : null;
    const step = (req.query.step as string | undefined) ?? null;
    const fromStr = (req.query.from as string | undefined) ?? null;
    const toStr = (req.query.to as string | undefined) ?? null;
    if (departmentId)
      conditions.push(eq(workflowsTable.departmentId, departmentId));
    if (step) conditions.push(eq(workflowsTable.currentStep, step));
    if (fromStr) conditions.push(gte(workflowsTable.createdAt, new Date(fromStr)));
    if (toStr) conditions.push(lte(workflowsTable.createdAt, new Date(toStr)));

    const rows = await db
      .select({
        w: workflowsTable,
        deptName: departmentsTable.name,
        creatorName: usersTable.displayName,
      })
      .from(workflowsTable)
      .leftJoin(
        departmentsTable,
        eq(departmentsTable.id, workflowsTable.departmentId),
      )
      .leftJoin(usersTable, eq(usersTable.id, workflowsTable.createdById))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(workflowsTable.createdAt));

    const visible = rows.filter((r) => canSeeWorkflow(user, r.w.departmentId));

    const headers = [
      "Reference",
      "Title",
      "Department",
      "Priority",
      "Step",
      "Branch",
      "Estimated amount",
      "Currency",
      "Order #",
      "Order date",
      "Delivered on",
      "Invoice #",
      "Invoice amount",
      "Invoice date",
      "Payment date",
      "Created by",
      "Created at",
      "Updated at",
    ];
    const records = visible.map((r) => ({
      Reference: r.w.reference,
      Title: r.w.title,
      Department: r.deptName ?? "",
      Priority: r.w.priority,
      Step: r.w.currentStep,
      Branch: r.w.branch ?? "",
      "Estimated amount":
        r.w.estimatedAmount != null ? Number(r.w.estimatedAmount) : "",
      Currency: r.w.currency ?? "",
      "Order #": r.w.orderNumber ?? "",
      "Order date": r.w.orderDate ?? "",
      "Delivered on": r.w.deliveredOn ?? "",
      "Invoice #": r.w.invoiceNumber ?? "",
      "Invoice amount":
        r.w.invoiceAmount != null ? Number(r.w.invoiceAmount) : "",
      "Invoice date": r.w.invoiceDate ?? "",
      "Payment date": r.w.paymentDate ?? "",
      "Created by": r.creatorName ?? "",
      "Created at": r.w.createdAt
        ? new Date(r.w.createdAt).toISOString()
        : "",
      "Updated at": r.w.updatedAt
        ? new Date(r.w.updatedAt).toISOString()
        : "",
    }));

    if (format === "csv") {
      const escape = (v: unknown): string => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [headers.join(",")];
      for (const rec of records) {
        lines.push(headers.map((h) => escape((rec as Record<string, unknown>)[h])).join(","));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="workflows-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.send(lines.join("\n"));
      return;
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Workflows");
    ws.columns = headers.map((h) => ({
      header: h,
      key: h,
      width: Math.max(12, h.length + 2),
    }));
    ws.getRow(1).font = { bold: true };
    for (const rec of records) ws.addRow(rec);
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="workflows-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    );
    res.send(Buffer.from(buf));
  },
);

export default router;
