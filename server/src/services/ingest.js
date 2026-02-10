import crypto from "crypto";
import db from "../db.js";
import { fetchAgencies, fetchTitles, fetchTitleXml } from "./ecfr.js";

function updateStatus(fields) {
  const sets = Object.keys(fields)
    .map((k) => `${k} = @${k}`)
    .join(", ");
  db.prepare(`UPDATE ingest_status SET ${sets} WHERE id = 1`).run(fields);
}

function flattenAgencies(agencies, parentSlug = null) {
  const result = [];
  for (const agency of agencies) {
    result.push({ ...agency, parent_slug: parentSlug });
    if (agency.children && agency.children.length > 0) {
      result.push(...flattenAgencies(agency.children, agency.slug));
    }
  }
  return result;
}

function stripXmlTags(xml) {
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-zA-Z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(text) {
  if (!text || text.trim().length === 0) return 0;
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function computeChecksum(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function extractChapterContent(xml, chapter) {
  const romanChapter = chapter;
  const patterns = [
    new RegExp(
      `<CHAPTER[^>]*>\\s*<HD[^>]*>[^<]*Chapter\\s+${romanChapter}[^<]*</HD>([\\s\\S]*?)(?=<CHAPTER[^>]*>\\s*<HD|$)`,
      "i",
    ),
    new RegExp(`<DIV3[^>]*N="${romanChapter}"[^>]*>([\\s\\S]*?)(?=<DIV3[^>]*N="|$)`, "i"),
    new RegExp(`<CHAPTER[^>]*N="${romanChapter}"[^>]*>([\\s\\S]*?)(?=<CHAPTER[^>]*N="|$)`, "i"),
  ];

  for (const pattern of patterns) {
    const match = xml.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function extractSubtitleContent(xml, subtitle) {
  const patterns = [
    new RegExp(`<SUBTITLE[^>]*N="${subtitle}"[^>]*>([\\s\\S]*?)(?=<SUBTITLE[^>]*N="|$)`, "i"),
    new RegExp(`<DIV2[^>]*N="${subtitle}"[^>]*>([\\s\\S]*?)(?=<DIV2[^>]*N="|$)`, "i"),
  ];

  for (const pattern of patterns) {
    const match = xml.match(pattern);
    if (match) return match[0];
  }
  return null;
}

export async function ingestAgenciesAndTitles() {
  updateStatus({
    status: "running",
    progress: 0,
    total: 2,
    message: "Fetching agencies...",
    started_at: new Date().toISOString(),
    completed_at: null,
  });

  const agencies = await fetchAgencies();
  const flat = flattenAgencies(agencies);

  const upsertAgency = db.prepare(`
    INSERT INTO agencies (slug, name, short_name, display_name, sortable_name, parent_slug, cfr_references, updated_at)
    VALUES (@slug, @name, @short_name, @display_name, @sortable_name, @parent_slug, @cfr_references, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      name = @name, short_name = @short_name, display_name = @display_name,
      sortable_name = @sortable_name, parent_slug = @parent_slug,
      cfr_references = @cfr_references, updated_at = datetime('now')
  `);

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      upsertAgency.run({
        slug: item.slug,
        name: item.name,
        short_name: item.short_name || null,
        display_name: item.display_name || item.name,
        sortable_name: item.sortable_name || item.name,
        parent_slug: item.parent_slug || null,
        cfr_references: JSON.stringify(item.cfr_references || []),
      });
    }
  });
  insertMany(flat);

  updateStatus({ progress: 1, message: "Fetching titles..." });

  const titles = await fetchTitles();
  const upsertTitle = db.prepare(`
    INSERT INTO titles (number, name, latest_amended_on, latest_issue_date, up_to_date_as_of, reserved)
    VALUES (@number, @name, @latest_amended_on, @latest_issue_date, @up_to_date_as_of, @reserved)
    ON CONFLICT(number) DO UPDATE SET
      name = @name, latest_amended_on = @latest_amended_on,
      latest_issue_date = @latest_issue_date, up_to_date_as_of = @up_to_date_as_of,
      reserved = @reserved
  `);

  const insertTitles = db.transaction((items) => {
    for (const t of items) {
      upsertTitle.run({
        number: t.number,
        name: t.name,
        latest_amended_on: t.latest_amended_on || null,
        latest_issue_date: t.latest_issue_date || null,
        up_to_date_as_of: t.up_to_date_as_of || null,
        reserved: t.reserved ? 1 : 0,
      });
    }
  });
  insertTitles(titles);

  updateStatus({
    status: "completed",
    progress: 2,
    message: "Agencies and titles ingested",
    completed_at: new Date().toISOString(),
  });
  return { agencyCount: flat.length, titleCount: titles.length };
}

export async function ingestContent() {
  const titles = db.prepare("SELECT number, name, up_to_date_as_of FROM titles WHERE reserved = 0").all();
  const agencies = db.prepare("SELECT slug, cfr_references FROM agencies").all();

  const titleToAgencyChapters = new Map();
  for (const agency of agencies) {
    const refs = JSON.parse(agency.cfr_references || "[]");
    for (const ref of refs) {
      const key = ref.title;
      if (!titleToAgencyChapters.has(key)) titleToAgencyChapters.set(key, []);
      titleToAgencyChapters.get(key).push({
        agencySlug: agency.slug,
        chapter: ref.chapter || null,
        subtitle: ref.subtitle || null,
        subchapter: ref.subchapter || null,
        part: ref.part || null,
      });
    }
  }

  const total = titles.length;
  updateStatus({
    status: "running",
    progress: 0,
    total,
    message: "Downloading regulation content...",
    started_at: new Date().toISOString(),
    completed_at: null,
  });

  const upsertContent = db.prepare(`
    INSERT INTO agency_cfr_content (agency_slug, title_number, chapter, subtitle, subchapter, part, word_count, section_count, checksum, last_fetched)
    VALUES (@agency_slug, @title_number, @chapter, @subtitle, @subchapter, @part, @word_count, @section_count, @checksum, @last_fetched)
    ON CONFLICT(agency_slug, title_number, COALESCE(chapter,''), COALESCE(subtitle,''), COALESCE(subchapter,''), COALESCE(part,''))
    DO UPDATE SET word_count = @word_count, section_count = @section_count, checksum = @checksum, last_fetched = @last_fetched
  `);

  for (let i = 0; i < titles.length; i++) {
    const title = titles[i];
    const mappings = titleToAgencyChapters.get(title.number) || [];
    if (mappings.length === 0) {
      updateStatus({ progress: i + 1, message: `Skipped title ${title.number} (no agency mappings)` });
      continue;
    }

    updateStatus({ progress: i, message: `Downloading Title ${title.number}: ${title.name}...` });

    let xml;
    try {
      xml = await fetchTitleXml(title.number, title.up_to_date_as_of);
    } catch (err) {
      console.error(`Failed to fetch title ${title.number}:`, err.message);
      updateStatus({ progress: i + 1, message: `Failed title ${title.number}: ${err.message}` });
      continue;
    }

    const fullText = stripXmlTags(xml);
    const fullWordCount = countWords(fullText);
    const sectionMatches = xml.match(/<SECTION[^>]*>/gi) || xml.match(/<DIV8[^>]*>/gi) || [];
    const fullSectionCount = sectionMatches.length;

    for (const mapping of mappings) {
      let chapterText = null;
      let chapterXml = null;

      if (mapping.chapter) {
        chapterXml = extractChapterContent(xml, mapping.chapter);
      } else if (mapping.subtitle) {
        chapterXml = extractSubtitleContent(xml, mapping.subtitle);
      }

      if (chapterXml) {
        chapterText = stripXmlTags(chapterXml);
      } else {
        const proportion = 1 / Math.max(mappings.length, 1);
        const estimatedWords = Math.round(fullWordCount * proportion);
        chapterText = fullText.substring(0, estimatedWords * 6);
      }

      const wordCount = countWords(chapterText);
      const sectionCount = chapterXml
        ? (chapterXml.match(/<SECTION[^>]*>/gi) || chapterXml.match(/<DIV8[^>]*>/gi) || []).length
        : Math.round(fullSectionCount / Math.max(mappings.length, 1));
      const checksum = computeChecksum(chapterText);

      upsertContent.run({
        agency_slug: mapping.agencySlug,
        title_number: title.number,
        chapter: mapping.chapter || null,
        subtitle: mapping.subtitle || null,
        subchapter: mapping.subchapter || null,
        part: mapping.part || null,
        word_count: wordCount,
        section_count: sectionCount,
        checksum,
        last_fetched: new Date().toISOString(),
      });
    }

    updateStatus({ progress: i + 1, message: `Completed Title ${title.number}: ${title.name}` });
  }

  const updateAgencyWordCounts = db.prepare(`
    UPDATE agencies SET
      word_count = COALESCE((SELECT SUM(word_count) FROM agency_cfr_content WHERE agency_slug = agencies.slug), 0),
      checksum = (SELECT GROUP_CONCAT(checksum, '-') FROM agency_cfr_content WHERE agency_slug = agencies.slug),
      last_fetched = datetime('now'),
      updated_at = datetime('now')
  `);
  updateAgencyWordCounts.run();

  const today = new Date().toISOString().split("T")[0];
  const agenciesWithCounts = db.prepare("SELECT slug, word_count, checksum FROM agencies WHERE word_count > 0").all();
  const insertSnapshot = db.prepare(`
    INSERT INTO snapshots (agency_slug, word_count, checksum, snapshot_date)
    VALUES (@agency_slug, @word_count, @checksum, @snapshot_date)
  `);
  const insertSnapshots = db.transaction((items) => {
    for (const a of items) {
      insertSnapshot.run({ agency_slug: a.slug, word_count: a.word_count, checksum: a.checksum, snapshot_date: today });
    }
  });
  insertSnapshots(agenciesWithCounts);

  updateStatus({
    status: "completed",
    progress: total,
    message: "Content ingestion complete",
    completed_at: new Date().toISOString(),
  });
}

export async function runFullIngest() {
  try {
    await ingestAgenciesAndTitles();
    await ingestContent();
  } catch (err) {
    console.error("Ingestion failed:", err);
    updateStatus({ status: "error", message: err.message, completed_at: new Date().toISOString() });
    throw err;
  }
}
