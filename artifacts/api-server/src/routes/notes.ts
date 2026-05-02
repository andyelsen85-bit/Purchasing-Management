import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, notesTable, workflowsTable, usersTable } from "@workspace/db";
import {
  ListWorkflowNotesParams,
  CreateWorkflowNoteParams,
  CreateWorkflowNoteBody,
} from "@workspace/api-zod";
import { requireAuth, getUser } from "../middlewares/auth";
import { canSeeWorkflow, canEditWorkflow } from "../lib/permissions";
import { audit } from "../lib/audit";

const router: IRouter = Router();

router.get(
  "/workflows/:id/notes",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = ListWorkflowNotesParams.safeParse(req.params);
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
        n: notesTable,
        authorName: usersTable.displayName,
      })
      .from(notesTable)
      .leftJoin(usersTable, eq(usersTable.id, notesTable.authorId))
      .where(eq(notesTable.workflowId, params.data.id))
      .orderBy(desc(notesTable.createdAt));
    res.json(
      rows.map((r) => ({
        id: r.n.id,
        workflowId: r.n.workflowId,
        step: r.n.step,
        body: r.n.body,
        authorName: r.authorName ?? "",
        createdAt: r.n.createdAt,
      })),
    );
  },
);

router.post(
  "/workflows/:id/notes",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = CreateWorkflowNoteParams.safeParse(req.params);
    const body = CreateWorkflowNoteBody.safeParse(req.body);
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
        error: "Forbidden — your role cannot write notes on this step",
      });
      return;
    }
    const [created] = await db
      .insert(notesTable)
      .values({
        workflowId: wf.id,
        step: body.data.step,
        body: body.data.body,
        authorId: user.id,
      })
      .returning();
    await audit(user.id, "NOTE_CREATE", "note", created!.id);
    res.status(201).json({
      id: created!.id,
      workflowId: created!.workflowId,
      step: created!.step,
      body: created!.body,
      authorName: user.displayName,
      createdAt: created!.createdAt,
    });
  },
);

export default router;
