import { Router, type IRouter } from "express";
import healthRouter from "./health";
import safetyRouter from "./safety";

const router: IRouter = Router();

router.use(healthRouter);
router.use(safetyRouter);

export default router;
