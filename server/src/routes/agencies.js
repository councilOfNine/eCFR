import { Router } from "express";
import db from "../db.js";

const router = Router();

router.get("/", (_req, res) => {
  try {
    const agencies = db
      .prepare(
        `
      SELECT slug, name, short_name, display_name, sortable_name, parent_slug,
             cfr_references, word_count, checksum, last_fetched
      FROM agencies
      WHERE parent_slug IS NULL
      ORDER BY sortable_name ASC
    `,
      )
      .all();

    const withChildren = agencies.map((a) => {
      const children = db
        .prepare(
          `
        SELECT slug, name, short_name, display_name, word_count, checksum
        FROM agencies WHERE parent_slug = ?
        ORDER BY sortable_name ASC
      `,
        )
        .all(a.slug);

      return {
        ...a,
        cfr_references: JSON.parse(a.cfr_references || "[]"),
        children_count: children.length,
        total_word_count: a.word_count + children.reduce((sum, c) => sum + c.word_count, 0),
      };
    });

    res.json({ agencies: withChildren });
  } catch (err) {
    console.error("Error fetching agencies:", err);
    res.status(500).json({ error: "Failed to fetch agencies" });
  }
});

router.get("/:slug", async (req, res) => {
  try {
    const agency = db
      .prepare(
        `
      SELECT slug, name, short_name, display_name, sortable_name, parent_slug,
             cfr_references, word_count, checksum, last_fetched
      FROM agencies WHERE slug = ?
    `,
      )
      .get(req.params.slug);

    if (!agency) return res.status(404).json({ error: "Agency not found" });

    const children = db
      .prepare(
        `
      SELECT slug, name, short_name, display_name, word_count, checksum, cfr_references
      FROM agencies WHERE parent_slug = ?
      ORDER BY sortable_name ASC
    `,
      )
      .all(agency.slug);

    const cfrContent = db
      .prepare(
        `
      SELECT acc.*, t.name as title_name
      FROM agency_cfr_content acc
      LEFT JOIN titles t ON t.number = acc.title_number
      WHERE acc.agency_slug = ?
      ORDER BY acc.title_number ASC
    `,
      )
      .all(agency.slug);

    // Fetch revision counts from eCFR for each CFR content entry (in parallel, with timeout)
    const BASE_URL = "https://www.ecfr.gov";
    const cfrWithRevisions = await Promise.all(
      cfrContent.map(async (c) => {
        try {
          const params = new URLSearchParams();
          if (c.chapter) params.set("chapter", c.chapter);
          if (c.part) params.set("part", c.part);
          const url = `${BASE_URL}/api/versioner/v1/versions/title-${c.title_number}?${params.toString()}`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const r = await fetch(url, { signal: controller.signal });
          clearTimeout(timeout);
          if (!r.ok) return { ...c, revision_count: null };
          const data = await r.json();
          const versions = data.content_versions || [];
          return { ...c, revision_count: versions.length };
        } catch {
          return { ...c, revision_count: null };
        }
      }),
    );

    const snapshots = db
      .prepare(
        `
      SELECT word_count, checksum, snapshot_date
      FROM snapshots WHERE agency_slug = ?
      ORDER BY snapshot_date ASC
    `,
      )
      .all(agency.slug);

    const childrenWithRefs = children.map((c) => ({
      ...c,
      cfr_references: JSON.parse(c.cfr_references || "[]"),
    }));

    res.json({
      agency: {
        ...agency,
        cfr_references: JSON.parse(agency.cfr_references || "[]"),
      },
      children: childrenWithRefs,
      cfr_content: cfrWithRevisions,
      history: snapshots,
    });
  } catch (err) {
    console.error("Error fetching agency:", err);
    res.status(500).json({ error: "Failed to fetch agency" });
  }
});

export default router;
