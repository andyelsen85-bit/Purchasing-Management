import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import departmentsRouter from "./departments";
import companiesRouter from "./companies";
import workflowsRouter from "./workflows";
import documentsRouter from "./documents";
import notesRouter from "./notes";
import historyRouter from "./history";
import dashboardRouter from "./dashboard";
import auditRouter from "./audit";
import gtInvestRouter from "./gtInvest";
import settingsRouter from "./settings";
import tlsRouter from "./tls";
import exportsRouter from "./exports";
import notificationsRouter from "./notifications";
import backupRouter from "./backup";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(departmentsRouter);
router.use(companiesRouter);
// exportsRouter must come before workflowsRouter so its
// /workflows/export path isn't shadowed by /workflows/:id.
router.use(exportsRouter);
router.use(workflowsRouter);
router.use(documentsRouter);
router.use(notesRouter);
router.use(historyRouter);
router.use(dashboardRouter);
router.use(auditRouter);
router.use(gtInvestRouter);
router.use(settingsRouter);
router.use(tlsRouter);
router.use(notificationsRouter);
router.use(backupRouter);

export default router;
