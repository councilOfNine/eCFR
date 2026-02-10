import { Router } from "express";
import agenciesRouter from "./agencies.js";
import statsRouter from "./stats.js";
import ingestRouter from "./ingest.js";
import wordcountsRouter from "./wordcounts.js";
import regulationRouter from "./regulation.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

router.use("/agencies", agenciesRouter);
router.use("/stats", statsRouter);
router.use("/ingest", ingestRouter);
router.use("/wordcounts", wordcountsRouter);
router.use("/regulation", regulationRouter);

export default router;
