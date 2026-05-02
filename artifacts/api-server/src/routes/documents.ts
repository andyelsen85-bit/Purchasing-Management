import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, documentsTable, workflowsTable, usersTable } from "@workspace/db";
import {
  ListWorkflowDocumentsParams,
  UploadWorkflowDocumentParams,
  UploadWorkflowDocumentBody,
  DeleteDocumentParams,
} from "@workspace/api-zod";
import { requireAuth, getUser } from "../middlewares/auth";
import { canSeeWorkflow, canEditWorkflow } from "../lib/permissions";
import { audit } from "../lib/audit";

const router: IRouter = Router();

router.get(
  "/workflows/:id/documents",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = ListWorkflowDocumentsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [wf] = await db
      .select()
      .from(workflowsTable)
      .where(eq(workflowsTable.id, params.data.id));
    if (!wf) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!canSeeWorkflow(getUser(req), wf.departmentId)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const rows = await db
      .select({
        d: documentsTable,
        uploaderName: usersTable.displayName,
      })
      .from(documentsTable)
      .leftJoin(usersTable, eq(usersTable.id, documentsTable.uploadedById))
      .where(eq(documentsTable.workflowId, params.data.id))
      .orderBy(desc(documentsTable.uploadedAt));
    res.json(
      rows.map((r) => ({
        id: r.d.id,
        workflowId: r.d.workflowId,
        step: r.d.step,
        filename: r.d.filename,
        mimeType: r.d.mimeType,
        sizeBytes: r.d.sizeBytes,
        kind: r.d.kind,
        version: r.d.version,
        previousVersionId: r.d.previousVersionId,
        isCurrent: r.d.isCurrent,
        dataUrl: `data:${r.d.mimeType};base64,${r.d.contentBase64}`,
        uploadedByName: r.uploaderName ?? "",
        uploadedAt: r.d.uploadedAt,
      })),
    );
  },
);

router.post(
  "/workflows/:id/documents",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = UploadWorkflowDocumentParams.safeParse(req.params);
    const body = UploadWorkflowDocumentBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const [wf] = await db
      .select()
      .from(workflowsTable)
      .where(eq(workflowsTable.id, params.data.id));
    if (!wf) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const user = getUser(req);
    if (
      !canEditWorkflow(
        user,
        wf.departmentId,
        wf.currentStep as Parameters<typeof canEditWorkflow>[2],
      )
    ) {
      res.status(403).json({
        error: "Forbidden — your role cannot upload documents on this step",
      });
      return;
    }
    // Determine version: if a current doc with same kind exists, mark old as not current
    const previous = await db
      .select()
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.workflowId, wf.id),
          eq(documentsTable.kind, body.data.kind),
          eq(documentsTable.isCurrent, true),
        ),
      );
    let version = 1;
    let previousVersionId: number | null = null;
    if (previous.length > 0) {
      const prev = previous[0];
      version = (prev.version ?? 1) + 1;
      previousVersionId = prev.id;
      await db
        .update(documentsTable)
        .set({ isCurrent: false })
        .where(eq(documentsTable.id, prev.id));
    }
    const sizeBytes = Math.floor((body.data.contentBase64.length * 3) / 4);
    const [created] = await db
      .insert(documentsTable)
      .values({
        workflowId: wf.id,
        step: body.data.step,
        filename: body.data.filename,
        mimeType: body.data.mimeType,
        sizeBytes,
        kind: body.data.kind,
        version,
        previousVersionId,
        contentBase64: body.data.contentBase64,
        uploadedById: user.id,
        isCurrent: true,
      })
      .returning();
    await audit(user.id, "DOCUMENT_UPLOAD", "document", created!.id, body.data.filename);
    res.status(201).json({
      id: created!.id,
      workflowId: created!.workflowId,
      step: created!.step,
      filename: created!.filename,
      mimeType: created!.mimeType,
      sizeBytes: created!.sizeBytes,
      kind: created!.kind,
      version: created!.version,
      previousVersionId: created!.previousVersionId,
      isCurrent: created!.isCurrent,
      dataUrl: `data:${created!.mimeType};base64,${created!.contentBase64}`,
      uploadedByName: user.displayName,
      uploadedAt: created!.uploadedAt,
    });
  },
);

router.get(
  "/documents/:id/download",
  requireAuth,
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [doc] = await db
      .select()
      .from(documentsTable)
      .where(eq(documentsTable.id, id));
    if (!doc) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [wf] = await db
      .select()
      .from(workflowsTable)
      .where(eq(workflowsTable.id, doc.workflowId));
    if (!wf || !canSeeWorkflow(getUser(req), wf.departmentId)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const buf = Buffer.from(doc.contentBase64, "base64");
    res.setHeader("Content-Type", doc.mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${doc.filename.replace(/"/g, "")}"`,
    );
    res.send(buf);
  },
);

router.delete("/documents/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteDocumentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const user = getUser(req);
  if (!user.roles.includes("ADMIN")) {
    res.status(403).json({ error: "Only admins can delete documents" });
    return;
  }
  await db.delete(documentsTable).where(eq(documentsTable.id, params.data.id));
  await audit(user.id, "DOCUMENT_DELETE", "document", params.data.id);
  res.sendStatus(204);
});

export default router;
