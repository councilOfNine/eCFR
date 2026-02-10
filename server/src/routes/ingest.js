import { Router } from "express";
import db from "../db.js";
import { ingestAgenciesAndTitles, runFullIngest } from "../services/ingest.js";

const router = Router();

router.post("/quick", async (_req, res) => {
  try {
    const status = db.prepare("SELECT status FROM ingest_status WHERE id = 1").get();
    if (status?.status === "running") {
      return res.status(409).json({ error: "Ingestion already in progress" });
    }
    const result = await ingestAgenciesAndTitles();
    res.json({ message: "Quick ingest complete", ...result });
  } catch (err) {
    console.error("Quick ingest failed:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/full", async (_req, res) => {
  try {
    const status = db.prepare("SELECT status FROM ingest_status WHERE id = 1").get();
    if (status?.status === "running") {
      return res.status(409).json({ error: "Ingestion already in progress" });
    }
    res.json({ message: "Full ingestion started. This may take several minutes." });
    runFullIngest().catch((err) => console.error("Background ingest error:", err));
  } catch (err) {
    console.error("Full ingest failed:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/status", (_req, res) => {
  try {
    const status = db.prepare("SELECT * FROM ingest_status WHERE id = 1").get();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/reset", (_req, res) => {
  try {
    db.prepare(
      "UPDATE ingest_status SET status = 'idle', progress = 0, total = 0, message = NULL, started_at = NULL, completed_at = NULL WHERE id = 1",
    ).run();
    res.json({ message: "Ingest status reset" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
