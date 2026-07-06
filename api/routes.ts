import { Router } from "express";
import { router as reposRouter } from "./routes/repos";
import { router as contentRouter } from "./routes/content";
import { router as cacheRouter } from "./routes/cache";
import { router as collaboratorsRouter } from "./routes/collaborators";
import { router as webhookRouter } from "./routes/webhook";
import { router as generalRouter } from "./routes/general";
import { router as filesRouter } from "./routes/files";

const router = Router();

router.use(reposRouter);
router.use(contentRouter);
router.use(cacheRouter);
router.use(collaboratorsRouter);
router.use(webhookRouter);
router.use(generalRouter);
router.use(filesRouter);

export { router };
