import { Router } from "express";
import db from "../db.js";

const BASE_URL = "https://www.ecfr.gov";

const router = Router();

function xmlToHtml(xml) {
  let html = xml;
  html = html.replace(/<\?xml[^?]*\?>/gi, "");
  html = html.replace(/<HD SOURCE="HED">(.*?)<\/HD>/gi, '<h2 class="reg-heading">$1</h2>');
  html = html.replace(/<HD SOURCE="HD1">(.*?)<\/HD>/gi, '<h3 class="reg-subheading">$1</h3>');
  html = html.replace(/<HD SOURCE="HD2">(.*?)<\/HD>/gi, '<h4 class="reg-subheading-2">$1</h4>');
  html = html.replace(/<HD SOURCE="HD3">(.*?)<\/HD>/gi, '<h5 class="reg-subheading-3">$1</h5>');
  html = html.replace(/<HD[^>]*>(.*?)<\/HD>/gi, '<h4 class="reg-subheading">$1</h4>');
  html = html.replace(/<HEAD>([\s\S]*?)<\/HEAD>/gi, '<h3 class="reg-subheading">$1</h3>');
  html = html.replace(/<HED>(.*?)<\/HED>/gi, "");
  html = html.replace(/<PSPACE>([\s\S]*?)<\/PSPACE>/gi, "$1");
  html = html.replace(/<P>([\s\S]*?)<\/P>/gi, '<p class="reg-paragraph">$1</p>');
  html = html.replace(/<SECTNO>(.*?)<\/SECTNO>/gi, '<span class="reg-section-number">$1</span>');
  html = html.replace(/<SUBJECT>(.*?)<\/SUBJECT>/gi, '<span class="reg-section-subject">$1</span>');
  html = html.replace(/<SECTION[^>]*>/gi, '<div class="reg-section">');
  html = html.replace(/<\/SECTION>/gi, "</div>");
  html = html.replace(/<AUTH>([\s\S]*?)<\/AUTH>/gi, '<div class="reg-auth"><strong>Authority:</strong> $1</div>');
  html = html.replace(/<SOURCE>([\s\S]*?)<\/SOURCE>/gi, '<div class="reg-source"><strong>Source:</strong> $1</div>');
  html = html.replace(/<E T="03">(.*?)<\/E>/gi, "<em>$1</em>");
  html = html.replace(/<E T="04">(.*?)<\/E>/gi, "<strong><em>$1</em></strong>");
  html = html.replace(/<E[^>]*>(.*?)<\/E>/gi, "<em>$1</em>");
  html = html.replace(/<I>(.*?)<\/I>/gi, "<em>$1</em>");
  html = html.replace(/<SU>(.*?)<\/SU>/gi, "<sup>$1</sup>");
  html = html.replace(/<FP[^>]*>([\s\S]*?)<\/FP>/gi, '<p class="reg-footnote">$1</p>');
  html = html.replace(/<FTNT>([\s\S]*?)<\/FTNT>/gi, '<aside class="reg-footnote-block">$1</aside>');
  html = html.replace(/<PART[^>]*>/gi, '<article class="reg-part">');
  html = html.replace(/<\/PART>/gi, "</article>");
  html = html.replace(/<SUBPART[^>]*>/gi, '<section class="reg-subpart">');
  html = html.replace(/<\/SUBPART>/gi, "</section>");
  html = html.replace(/<CONTENTS>[\s\S]*?<\/CONTENTS>/gi, "");
  html = html.replace(
    /<GPOTABLE[^>]*>([\s\S]*?)<\/GPOTABLE>/gi,
    '<div class="overflow-x-auto my-4"><table class="min-w-full text-sm border">$1</table></div>',
  );
  html = html.replace(/<ROW>([\s\S]*?)<\/ROW>/gi, "<tr>$1</tr>");
  html = html.replace(/<ENT[^>]*>([\s\S]*?)<\/ENT>/gi, '<td class="border px-2 py-1">$1</td>');
  html = html.replace(/<CHED[^>]*>([\s\S]*?)<\/CHED>/gi, '<th class="border px-2 py-1 font-semibold bg-muted">$1</th>');
  html = html.replace(/<BOXHD>([\s\S]*?)<\/BOXHD>/gi, "<thead>$1</thead>");
  html = html.replace(/<TTITLE>([\s\S]*?)<\/TTITLE>/gi, '<caption class="text-sm font-medium mb-2">$1</caption>');
  html = html.replace(/<EAR>(.*?)<\/EAR>/gi, '<p class="text-xs text-muted-foreground italic">$1</p>');
  html = html.replace(/<APPRO[^>]*>([\s\S]*?)<\/APPRO>/gi, '<div class="reg-source">$1</div>');
  html = html.replace(
    /<\/?(?:CHAPTER|SUBCHAP|TITLE|DIV\d+|TITLENO|CFRTOC|SECHD|RESERVED|CITA|PRTPAGE|GPH|GID|MATH|EFFDNOT|EDNOTE|EXTRACT|AC|APTS|FRDOC|BILCOD|STARS|LDRWK|LI|NOLDR|NOHDR|NOTE|NOTES|SIG|DATED|NAME|FP-DASH)[^>]*>/gi,
    "",
  );
  html = html.replace(/<\/?[A-Z][A-Z0-9]*[^>]*>/g, "");
  html = html.replace(/\n{3,}/g, "\n\n");
  return html.trim();
}

function xmlToText(xml) {
  let text = xml;
  text = text.replace(/<\?xml[^?]*\?>/gi, "");
  text = text.replace(/<CONTENTS>[\s\S]*?<\/CONTENTS>/gi, "");
  text = text.replace(/<HEAD>([\s\S]*?)<\/HEAD>/gi, "$1\n");
  text = text.replace(/<HD[^>]*>([\s\S]*?)<\/HD>/gi, "$1\n");
  text = text.replace(/<HED>(.*?)<\/HED>/gi, "");
  text = text.replace(/<PSPACE>([\s\S]*?)<\/PSPACE>/gi, "$1");
  text = text.replace(/<SECTNO>(.*?)<\/SECTNO>/gi, "$1 ");
  text = text.replace(/<SUBJECT>(.*?)<\/SUBJECT>/gi, "$1\n");
  text = text.replace(/<P>([\s\S]*?)<\/P>/gi, "$1\n");
  text = text.replace(/<FP[^>]*>([\s\S]*?)<\/FP>/gi, "$1\n");
  text = text.replace(/<AUTH>([\s\S]*?)<\/AUTH>/gi, "Authority: $1\n");
  text = text.replace(/<SOURCE>([\s\S]*?)<\/SOURCE>/gi, "Source: $1\n");
  text = text.replace(/<E[^>]*>(.*?)<\/E>/gi, "$1");
  text = text.replace(/<I>(.*?)<\/I>/gi, "$1");
  text = text.replace(/<SU>(.*?)<\/SU>/gi, "$1");
  text = text.replace(/<EAR>(.*?)<\/EAR>/gi, "$1\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  text = text.replace(/[ \t]+/g, " ");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function extractRegulatoryMeta(xml) {
  const meta = {};
  // Authority citation
  const authMatch = xml.match(/<AUTH[^>]*>[\s\S]*?<PSPACE>([\s\S]*?)<\/PSPACE>[\s\S]*?<\/AUTH>/i);
  if (authMatch) meta.authority = authMatch[1].replace(/<[^>]+>/g, "").trim();
  // Source citation
  const srcMatch = xml.match(/<SOURCE[^>]*>[\s\S]*?<PSPACE>([\s\S]*?)<\/PSPACE>[\s\S]*?<\/SOURCE>/i);
  if (srcMatch) meta.source = srcMatch[1].replace(/<[^>]+>/g, "").trim();
  // All FR citations (e.g. "73 FR 59194")
  const frCiteMap = {};
  function addFrCites(text) {
    for (const r of text.matchAll(/(\d+)\s+FR\s+(\d+)/g)) {
      const key = `${r[1]} FR ${r[2]}`;
      if (!frCiteMap[key]) frCiteMap[key] = { volume: r[1], page: r[2], cite: key };
    }
  }
  for (const m of xml.matchAll(/<CITA[^>]*>([\s\S]*?)<\/CITA>/gi)) addFrCites(m[1]);
  if (meta.source) addFrCites(meta.source);
  meta.fr_citations = Object.values(frCiteMap);
  return meta;
}

function extractSectionByIdentifier(xml, identifier) {
  const escaped = identifier.replace(/\./g, "\\.");
  const patterns = [
    new RegExp(`<SECTION[^>]*>[\\s\\S]*?<SECTNO>[^<]*§\\s*${escaped}[^<]*<\\/SECTNO>[\\s\\S]*?<\\/SECTION>`, "i"),
    new RegExp(`<DIV8[^>]*N="${escaped}"[^>]*>[\\s\\S]*?<\\/DIV8>`, "i"),
  ];
  for (const p of patterns) {
    const m = xml.match(p);
    if (m) return m[0];
  }
  return null;
}

function computeDiff(oldLines, newLines) {
  const m = oldLines.length;
  const n = newLines.length;

  if (m === 0 && n === 0) return [];
  if (m === 0) return newLines.map((l) => ({ type: "add", text: l }));
  if (n === 0) return oldLines.map((l) => ({ type: "remove", text: l }));

  // Build LCS table
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const result = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: "context", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: "add", text: newLines[j - 1] });
      j--;
    } else {
      result.unshift({ type: "remove", text: oldLines[i - 1] });
      i--;
    }
  }

  return result;
}

function collapseDiff(diffLines, contextSize = 3) {
  // Find ranges that have changes
  const hunks = [];
  let currentHunk = null;
  let contextBuffer = [];

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    if (line.type !== "context") {
      if (!currentHunk) {
        currentHunk = { lines: [...contextBuffer.slice(-contextSize)] };
        hunks.push(currentHunk);
      }
      contextBuffer = [];
      currentHunk.lines.push(line);
    } else {
      contextBuffer.push(line);
      if (currentHunk) {
        if (contextBuffer.length <= contextSize * 2) {
          currentHunk.lines.push(line);
        } else {
          currentHunk = null;
        }
      }
    }
  }

  return hunks;
}

function extractPart(xml, partNumber) {
  const patterns = [
    new RegExp(`<PART[^>]*>\\s*<EAR>[^<]*Pt\\.\\s*${partNumber}[^<]*</EAR>[\\s\\S]*?</PART>`, "i"),
    new RegExp(`<DIV5[^>]*N="${partNumber}"[^>]*>[\\s\\S]*?</DIV5>`, "i"),
    new RegExp(`<PART[^>]*N="${partNumber}"[^>]*>[\\s\\S]*?</PART>`, "i"),
  ];
  for (const p of patterns) {
    const m = xml.match(p);
    if (m) return m[0];
  }
  return null;
}

function getTitle(titleNumber) {
  return db.prepare("SELECT * FROM titles WHERE number = ?").get(titleNumber);
}

function getAgencyInfo(slug) {
  if (!slug) return null;
  return db.prepare("SELECT slug, name, short_name FROM agencies WHERE slug = ?").get(slug);
}

// ─── GET /regulation/:titleNumber/structure ────────────────────────────────────
// Returns the table-of-contents hierarchy from eCFR structure API.
// Filters to a specific chapter if ?chapter= is provided.
router.get("/:titleNumber/structure", async (req, res) => {
  try {
    const titleNumber = parseInt(req.params.titleNumber, 10);
    if (isNaN(titleNumber)) return res.status(400).json({ error: "Invalid title number" });

    const title = getTitle(titleNumber);
    if (!title) return res.status(404).json({ error: "Title not found" });

    const date = title.up_to_date_as_of || new Date().toISOString().split("T")[0];
    const structRes = await fetch(`${BASE_URL}/api/versioner/v1/structure/${date}/title-${titleNumber}.json`);
    if (!structRes.ok) return res.status(502).json({ error: `eCFR structure API error: ${structRes.status}` });
    const structure = await structRes.json();

    const { chapter, subtitle } = req.query;

    let filtered = structure;
    if (chapter) {
      const ch = (structure.children || []).find((c) => c.type === "chapter" && c.identifier === chapter);
      if (ch) filtered = ch;
    }
    if (subtitle) {
      const sub = (filtered.children || []).find((c) => c.type === "subtitle" && c.identifier === subtitle);
      if (sub) filtered = sub;
    }

    function simplify(node) {
      return {
        type: node.type,
        identifier: node.identifier,
        label: node.label || node.label_description || "",
        label_level: node.label_level || "",
        label_description: node.label_description || "",
        reserved: node.reserved || false,
        children: (node.children || []).map(simplify),
        descendant_range: node.descendant_range || null,
        size: node.size || null,
      };
    }

    res.json({
      title: { number: titleNumber, name: title.name, date },
      structure: simplify(filtered),
    });
  } catch (err) {
    console.error("Error fetching structure:", err);
    res.status(500).json({ error: "Failed to fetch structure" });
  }
});

// ─── GET /regulation/:titleNumber/revision-counts ──────────────────────────────
// Returns revision counts grouped by part for a chapter. Single eCFR request.
router.get("/:titleNumber/revision-counts", async (req, res) => {
  try {
    const titleNumber = parseInt(req.params.titleNumber, 10);
    if (isNaN(titleNumber)) return res.status(400).json({ error: "Invalid title number" });

    const { chapter } = req.query;

    let url = `${BASE_URL}/api/versioner/v1/versions/title-${titleNumber}`;
    if (chapter) url += `?chapter=${chapter}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const verRes = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!verRes.ok) return res.status(502).json({ error: `eCFR versions API error: ${verRes.status}` });
    const data = await verRes.json();

    const versions = data.content_versions || [];
    const byPart = {};
    for (const v of versions) {
      if (!v.part) continue;
      byPart[v.part] = (byPart[v.part] || 0) + 1;
    }

    res.json({ title_number: titleNumber, chapter: chapter || null, counts: byPart });
  } catch (err) {
    if (err.name === "AbortError") {
      return res.json({
        title_number: parseInt(req.params.titleNumber, 10),
        chapter: req.query.chapter || null,
        counts: {},
        timeout: true,
      });
    }
    console.error("Error fetching revision counts:", err);
    res.status(500).json({ error: "Failed to fetch revision counts" });
  }
});

// ─── GET /regulation/:titleNumber/versions ─────────────────────────────────────
// Returns revision history for a title, filterable by part.
router.get("/:titleNumber/versions", async (req, res) => {
  try {
    const titleNumber = parseInt(req.params.titleNumber, 10);
    if (isNaN(titleNumber)) return res.status(400).json({ error: "Invalid title number" });

    const { chapter, part } = req.query;

    let url = `${BASE_URL}/api/versioner/v1/versions/title-${titleNumber}`;
    const params = new URLSearchParams();
    if (chapter) params.set("chapter", chapter);
    if (part) params.set("part", part);
    const qs = params.toString();
    if (qs) url += "?" + qs;

    const verRes = await fetch(url);
    if (!verRes.ok) return res.status(502).json({ error: `eCFR versions API error: ${verRes.status}` });
    const data = await verRes.json();

    const versions = data.content_versions || [];

    // Group by date for summary view
    const byDate = {};
    for (const v of versions) {
      if (!byDate[v.date]) {
        byDate[v.date] = { date: v.date, amendment_date: v.amendment_date, issue_date: v.issue_date, sections: [] };
      }
      byDate[v.date].sections.push({
        identifier: v.identifier,
        name: v.name,
        part: v.part,
        type: v.type,
        removed: v.removed,
        substantive: v.substantive,
      });
    }

    const grouped = Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date));

    res.json({
      title_number: titleNumber,
      total_versions: versions.length,
      grouped_count: grouped.length,
      versions: grouped.slice(0, 100),
    });
  } catch (err) {
    console.error("Error fetching versions:", err);
    res.status(500).json({ error: "Failed to fetch version history" });
  }
});

// ─── GET /regulation/:titleNumber/diff ──────────────────────────────────────────
// Computes a text diff for specific sections between two dates.
// Required: ?date=YYYY-MM-DD&sections=1.1,1.3 (comma-separated section identifiers)
// Optional: ?part=N (helps narrow XML extraction)
router.get("/:titleNumber/diff", async (req, res) => {
  try {
    const titleNumber = parseInt(req.params.titleNumber, 10);
    if (isNaN(titleNumber)) return res.status(400).json({ error: "Invalid title number" });

    const { date, sections, part } = req.query;
    if (!date) return res.status(400).json({ error: "date query parameter is required" });
    if (!sections)
      return res.status(400).json({ error: "sections query parameter is required (comma-separated identifiers)" });

    const sectionIds = sections
      .split(",")
      .map((s) => s.trim())
      .slice(0, 50);

    // Compute the day before the amendment date
    const newDate = date;
    const d = new Date(date);
    d.setDate(d.getDate() - 1);
    const oldDate = d.toISOString().split("T")[0];

    // Helper: fetch XML with timeout, returning empty string on error/non-XML
    async function fetchXml(fetchDate) {
      const partQs = part ? `?part=${part}` : "";
      const url = `${BASE_URL}/api/versioner/v1/full/${fetchDate}/title-${titleNumber}.xml${partQs}`;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const r = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!r.ok) return "";
        const text = await r.text();
        // eCFR sometimes returns JSON error even with 200 status
        if (text.trimStart().startsWith("{")) return "";
        return text;
      } catch {
        return "";
      }
    }

    const [oldScope, newScope] = await Promise.all([fetchXml(oldDate), fetchXml(newDate)]);

    // If new XML is empty, the content may not be available at the amendment_date.
    // The eCFR uses issue_date for content availability. Try issue_date if provided.
    let finalNewScope = newScope;
    if (!finalNewScope && req.query.issue_date) {
      finalNewScope = await fetchXml(req.query.issue_date);
    }

    const diffs = [];
    for (const secId of sectionIds) {
      const oldSection = oldScope ? extractSectionByIdentifier(oldScope, secId) : null;
      const newSection = finalNewScope ? extractSectionByIdentifier(finalNewScope, secId) : null;

      if (!oldSection && !newSection) {
        diffs.push({ section: secId, status: "not_found", hunks: [] });
        continue;
      }

      const oldLines = oldSection ? xmlToText(oldSection) : [];
      const newLines = newSection ? xmlToText(newSection) : [];

      if (oldLines.join("\n") === newLines.join("\n")) {
        diffs.push({ section: secId, status: "unchanged", hunks: [] });
        continue;
      }

      const diffResult = computeDiff(oldLines, newLines);
      const hunks = collapseDiff(diffResult);
      const added = diffResult.filter((l) => l.type === "add").length;
      const removed = diffResult.filter((l) => l.type === "remove").length;

      diffs.push({
        section: secId,
        status: !oldSection ? "added" : !newSection ? "removed" : "modified",
        added,
        removed,
        hunks,
      });
    }

    res.json({
      title_number: titleNumber,
      old_date: oldDate,
      new_date: newDate,
      diffs,
    });
  } catch (err) {
    console.error("Error computing diff:", err);
    res.status(500).json({ error: "Failed to compute diff" });
  }
});

// ─── GET /regulation/:titleNumber/content ──────────────────────────────────────
// Fetches regulation content at the *part* level for fast loading.
// Requires ?part=N. Falls back to chapter-level if no part specified but content is small.
router.get("/:titleNumber/content", async (req, res) => {
  try {
    const titleNumber = parseInt(req.params.titleNumber, 10);
    if (isNaN(titleNumber)) return res.status(400).json({ error: "Invalid title number" });

    const title = getTitle(titleNumber);
    if (!title) return res.status(404).json({ error: "Title not found" });

    const { chapter, subtitle, subchapter, part, agency } = req.query;

    if (!part) {
      return res.status(400).json({
        error:
          "A 'part' query parameter is required for content loading. Use the /structure endpoint to discover available parts.",
      });
    }

    const date = title.up_to_date_as_of || new Date().toISOString().split("T")[0];
    const xmlRes = await fetch(`${BASE_URL}/api/versioner/v1/full/${date}/title-${titleNumber}.xml?part=${part}`);
    if (!xmlRes.ok) return res.status(502).json({ error: `Failed to fetch from eCFR: ${xmlRes.status}` });
    const xml = await xmlRes.text();

    if (!xml || xml.trim().length < 50) {
      return res.status(404).json({ error: `Part ${part} not found in Title ${titleNumber}` });
    }

    const html = xmlToHtml(xml);
    const regulatoryMeta = extractRegulatoryMeta(xml);

    const labelParts = [`Title ${titleNumber}: ${title.name}`];
    if (chapter) labelParts.push(`Chapter ${chapter}`);
    if (subtitle) labelParts.push(`Subtitle ${subtitle}`);
    if (subchapter) labelParts.push(`Subchapter ${subchapter}`);
    labelParts.push(`Part ${part}`);

    res.json({
      title: { number: titleNumber, name: title.name, date },
      section_label: labelParts.join(" — "),
      agency: getAgencyInfo(agency),
      content_html: html,
      part,
      word_count_estimate: html.split(/\s+/).length,
      regulatory_meta: regulatoryMeta,
    });
  } catch (err) {
    console.error("Error fetching regulation content:", err);
    res.status(500).json({ error: "Failed to fetch regulation content" });
  }
});

export default router;
