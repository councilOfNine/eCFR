/**
 * A small in-memory dataset so `pnpm dev:web` works with no database and no network.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE NUMBERS IN THIS FILE ARE NOT MEASUREMENTS. THEY ARE ILLUSTRATIVE.
 *
 * Rule 1 of this project is "never write a number that was not measured", and a fixture is by
 * definition invented data. The resolution is not to avoid the fixture — a contributor needs to
 * be able to run the site — but to make it structurally impossible to mistake for real output:
 * `manifest.fixture` is true, which makes every page render a persistent banner, and
 * `manifest.source` is 'fixture', which /data-quality prints.
 *
 * Its second job is adversarial. The fixture deliberately contains every awkward case the real
 * corpus has, so a UI regression shows up in dev rather than in production:
 *   - a scope co-claimed by two agencies (42 CFR Chapter I, the real IHS/PHS overlap);
 *   - a reference that names a chapter AND a narrower part, the 12-of-487 case;
 *   - a reserved title with three null dates, the title-35 case;
 *   - an agency whose rollup is unknown because its coverage is partial;
 *   - nodes with each of the four unknown statuses;
 *   - a part with no body text, so the reader's "text unavailable" path is exercised;
 *   - a split part, so the subpart-slice navigation is exercised.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

import { REASON_NOT_COMPUTED } from '@ecfr-atlas/core';
import type { WordCount } from '@ecfr-atlas/core/api-schemas';
import type {
  AgencyPage,
  AgencyRef,
  AgencyRow,
  AtlasData,
  ChapterPage,
  PartSliceRef,
  PartView,
  SectionEntry,
  SharedScope,
  SnapshotManifest,
  TitlePage,
  TitleRow,
} from '../contract.js';
import { sectionAnchor } from '../routes.js';

const counted = (words: number): WordCount => ({
  words,
  status: 'counted',
  reason: null,
  method: 'xml_parse',
});
const rolled = (words: number): WordCount => ({
  words,
  status: 'rolled_up',
  reason: null,
  method: 'descendant_sum',
});
const unknown = (status: WordCount['status'], reason: string): WordCount => ({
  words: null,
  status,
  reason,
  method: null,
});
const reserved = (): WordCount => ({
  words: 0,
  status: 'reserved_empty',
  reason: null,
  method: 'reserved',
});

const EPA: AgencyRef = {
  slug: 'environmental-protection-agency',
  display_name: 'Environmental Protection Agency',
};
const IHS: AgencyRef = { slug: 'indian-health-service', display_name: 'Indian Health Service' };
const PHS: AgencyRef = { slug: 'public-health-service', display_name: 'Public Health Service' };
const OAR: AgencyRef = {
  slug: 'office-of-air-and-radiation',
  display_name: 'Office of Air and Radiation',
};

function agencyRow(
  ref: AgencyRef,
  over: Partial<AgencyRow> & Pick<AgencyRow, 'attributed' | 'deduplicated' | 'coverage'>,
): AgencyRow {
  return {
    slug: ref.slug,
    name: ref.display_name,
    short_name: null,
    display_name: ref.display_name,
    sortable_name: ref.display_name,
    parent_slug: null,
    depth: 0,
    children_count: 0,
    subtree_attributed: over.attributed,
    subtree_deduplicated: over.deduplicated,
    shared_refs: 0,
    ...over,
  };
}

const AGENCIES: AgencyRow[] = [
  agencyRow(EPA, {
    short_name: 'EPA',
    sortable_name: 'Environmental Protection Agency',
    children_count: 1,
    attributed: rolled(1_284_512),
    deduplicated: rolled(1_284_512),
    subtree_attributed: rolled(1_412_003),
    subtree_deduplicated: rolled(1_412_003),
    coverage: { refs_total: 2, refs_counted: 2, pct: 1 },
  }),
  agencyRow(OAR, {
    sortable_name: 'Environmental Protection Agency, Office of Air and Radiation',
    parent_slug: EPA.slug,
    depth: 1,
    attributed: rolled(127_491),
    deduplicated: rolled(127_491),
    coverage: { refs_total: 1, refs_counted: 1, pct: 1 },
  }),
  agencyRow(IHS, {
    short_name: 'IHS',
    sortable_name: 'Health and Human Services, Indian Health Service',
    attributed: rolled(486_220),
    // Halved against `attributed`: 42 CFR Chapter I is co-claimed with PHS, and the
    // deduplicated view divides a shared scope evenly so the corpus total is conserved.
    deduplicated: rolled(243_110),
    shared_refs: 1,
    coverage: { refs_total: 1, refs_counted: 1, pct: 1 },
  }),
  agencyRow(PHS, {
    short_name: 'PHS',
    sortable_name: 'Health and Human Services, Public Health Service',
    attributed: unknown(
      'not_computed',
      '1 of 2 scopes are not counted, so the attributed total cannot be summed',
    ),
    deduplicated: unknown(
      'not_computed',
      '1 of 2 scopes are not counted, so the deduplicated total cannot be summed',
    ),
    shared_refs: 1,
    coverage: { refs_total: 2, refs_counted: 1, pct: 0.5 },
  }),
];

const TITLES: TitleRow[] = [
  {
    number: 35,
    name: 'Panama Canal',
    // The real title-35 shape: reserved, and all three dates null. Any code that formats these
    // without a null guard throws on exactly one title, every night.
    reserved: true,
    latest_amended_on: null,
    latest_issue_date: null,
    up_to_date_as_of: null,
    word_count: reserved(),
    chapters: 0,
    parts: 0,
    sections: 0,
  },
  {
    number: 40,
    name: 'Protection of Environment',
    reserved: false,
    latest_amended_on: '2026-07-17',
    latest_issue_date: '2026-07-21',
    up_to_date_as_of: '2026-07-24',
    word_count: rolled(1_412_003),
    chapters: 1,
    parts: 2,
    sections: 4,
  },
  {
    number: 42,
    name: 'Public Health',
    reserved: false,
    latest_amended_on: '2026-06-30',
    latest_issue_date: '2026-07-20',
    up_to_date_as_of: '2026-07-24',
    word_count: unknown('not_computed', '1 of 3 descendants are not counted'),
    chapters: 1,
    parts: 1,
    sections: 1,
  },
].sort((a, b) => a.number - b.number);

const SHARED: SharedScope[] = [
  {
    ref_key: 'title-42/chapter-I',
    title_number: 42,
    title_name: 'Public Health',
    display: '42 CFR Chapter I',
    ecfr_url: 'https://www.ecfr.gov/current/title-42/chapter-I',
    label: 'Public Health Service, Department of Health and Human Services',
    narrowest_level: 'chapter',
    word_count: rolled(486_220),
    agencies: [IHS, PHS],
  },
];

const PART_BODY_60 = `
<section class="reg-section" id="${sectionAnchor('60.1')}">
  <h2><span class="reg-num">§ 60.1</span> Applicability.</h2>
  <p>Except as provided in subparts B and C, the provisions of this part apply to the owner or
  operator of any stationary source which contains an affected facility, the construction or
  modification of which is commenced after the date of publication in this part of any standard
  applicable to that facility.</p>
</section>
<section class="reg-section" id="${sectionAnchor('60.2')}">
  <h2><span class="reg-num">§ 60.2</span> Definitions.</h2>
  <p>The terms used in this part are defined in the Act or in this section as follows:</p>
  <p><em>Act</em> means the Clean Air Act (42 U.S.C. 7401 <em>et seq.</em>)</p>
  <p><em>Administrator</em> means the Administrator of the Environmental Protection Agency or an
  authorized representative.</p>
</section>
`.trim();

/** Build a section entry and its TOC anchor from one identifier, so the two cannot diverge. */
function section(identifier: string, label: string, words: WordCount): SectionEntry {
  return {
    citation: `section-${identifier}`,
    identifier,
    label,
    reserved: false,
    word_count: words,
    anchor: sectionAnchor(identifier),
  };
}

function partView(
  over: Partial<PartView> & Pick<PartView, 'identifier' | 'title_number'>,
): PartView {
  const base: PartView = {
    citation: `title-${over.title_number}/part-${over.identifier}`,
    identifier: over.identifier,
    title_number: over.title_number,
    label: `Part ${over.identifier}`,
    reserved: false,
    word_count: counted(0),
    sections: 0,
    title_name: 'Protection of Environment',
    chapter: null,
    subchapter: null,
    display: `${over.title_number} CFR Part ${over.identifier}`,
    ecfr_url: `https://www.ecfr.gov/current/title-${over.title_number}/part-${over.identifier}`,
    authority: null,
    source_note: null,
    editorial_note: null,
    last_amended_on: null,
    slice: null,
    slices: [],
    section_list: [],
    agencies: [],
    content_key: null,
    content_unavailable_reason: null,
    content_html: null,
    slice_by_anchor: null,
  };
  const merged = { ...base, ...over };
  // The count is always the length of the list, never a second hand-maintained number.
  merged.sections = merged.section_list.length;
  return merged;
}

const PARTS = new Map<string, PartView>();

PARTS.set(
  '40/60/',
  partView({
    title_number: 40,
    identifier: '60',
    label: 'Standards of Performance for New Stationary Sources',
    word_count: rolled(1_157_020),
    section_list: [
      section('60.1', 'Applicability', counted(88)),
      section('60.2', 'Definitions', counted(1_204)),
    ],
    chapter: { identifier: 'I', label: 'Environmental Protection Agency' },
    subchapter: { identifier: 'C', label: 'Air Programs' },
    authority: '42 U.S.C. 7401, 7411, 7413, 7414, 7416, 7429, 7430, 7601, and 7602.',
    source_note: '36 FR 24877, Dec. 23, 1971, unless otherwise noted.',
    last_amended_on: '2026-07-17',
    agencies: [EPA, OAR],
    content_key: 'title-40-part-60',
    content_html: PART_BODY_60,
    slice_by_anchor: null,
  }),
);

// Exercises the "no text in this build" path without needing a D1 file.
PARTS.set(
  '40/63/',
  partView({
    title_number: 40,
    identifier: '63',
    label: 'National Emission Standards for Hazardous Air Pollutants for Source Categories',
    word_count: unknown(
      'unavailable_too_large',
      'the part exceeds the per-node processing ceiling and was skipped rather than counted partially',
    ),
    section_list: [
      section(
        '63.1',
        'Applicability',
        unknown(
          'unavailable_too_large',
          'the enclosing part was skipped, so no section under it was counted',
        ),
      ),
    ],
    chapter: { identifier: 'I', label: 'Environmental Protection Agency' },
    subchapter: { identifier: 'C', label: 'Air Programs' },
    agencies: [EPA],
    content_unavailable_reason:
      'This part is above the per-page processing ceiling in this build. Read it on the official eCFR.',
  }),
);

// Exercises subpart slicing: a slice index plus two slices. The real trigger for this is size —
// 36 parts exceed 2 MB and 26 CFR Part 1 is 69,598,633 bytes, which is also over Cloudflare's
// 25 MiB per-asset cap, so a single-page render of it cannot be deployed at all.
const CHAPTER_42_I = {
  identifier: 'I',
  label: 'Public Health Service, Department of Health and Human Services',
};

const SPLIT_SLICES: PartSliceRef[] = [
  { subpart: null, label: 'All subparts', word_count: rolled(96_400) },
  { subpart: 'A', label: 'Subpart A — General', word_count: counted(41_200) },
  { subpart: 'B', label: 'Subpart B — Eligibility', word_count: counted(55_200) },
];

PARTS.set(
  '42/136/',
  partView({
    title_number: 42,
    identifier: '136',
    title_name: 'Public Health',
    label: 'Indian Health',
    word_count: rolled(96_400),
    section_list: [
      section('136.1', 'Purpose', counted(310)),
      section('136.11', 'Eligibility', counted(902)),
    ],
    chapter: CHAPTER_42_I,
    agencies: [IHS, PHS],
    slices: SPLIT_SLICES,
    content_unavailable_reason:
      'This part is published in two slices because its text exceeds the per-page ceiling. Choose a subpart below.',
  }),
);

for (const slice of SPLIT_SLICES) {
  if (slice.subpart === null) continue;
  const id = slice.subpart;
  const sectionId = id === 'A' ? '136.1' : '136.11';
  PARTS.set(
    `42/136/${id}`,
    partView({
      title_number: 42,
      identifier: '136',
      title_name: 'Public Health',
      label: 'Indian Health',
      word_count: slice.word_count,
      section_list: [section(sectionId, slice.label, slice.word_count)],
      chapter: CHAPTER_42_I,
      agencies: [IHS, PHS],
      slice: id,
      slices: SPLIT_SLICES,
      content_key: `title-42-part-136-subpart-${id}`,
      content_html: `<section class="reg-section" id="${sectionAnchor(sectionId)}">
  <h2><span class="reg-num">§ ${sectionId}</span> ${slice.label}.</h2>
  <p>Fixture text for ${slice.label}. A real build renders the sanitised regulation body written
  by the sync pipeline into the snapshot's <code>content/</code> directory.</p>
</section>`,
    }),
  );
}

const MANIFEST: SnapshotManifest = {
  snapshot_version: 1,
  generated_at: new Date().toISOString(),
  run_id: null,
  source_date: null,
  latest_issue_date: '2026-07-21',
  fixture: true,
  source: 'fixture',
  corpus: {
    deduplicated: unknown('not_computed', '2 of 4 agency rollups are not counted'),
    attributed: unknown('not_computed', '2 of 4 agency rollups are not counted'),
    shared: rolled(486_220),
    agencies: AGENCIES.length,
    titles: TITLES.length,
    titles_reserved: 1,
    chapters: 2,
    parts: 3,
    sections: 5,
    structure_nodes: 13,
    refs_total: 6,
    shared_scopes: 1,
    amendments: 41,
    nodes_unknown: 4,
  },
};

/** Twelve months of invented activity, shaped like the real thing: business days only. */
function fixtureBuckets(seed: number) {
  const buckets: { month: string; count: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(2026, 6 - i, 1));
    buckets.push({
      month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
      count: ((seed * (i + 3)) % 17) + 4,
    });
  }
  return buckets;
}

export function loadFixtureSource(): AtlasData {
  const byslug = new Map(AGENCIES.map((a) => [a.slug, a]));

  const api: AtlasData = {
    manifest: MANIFEST,

    routes() {
      return Promise.resolve({
        agencies: AGENCIES.map((a) => a.slug),
        titles: TITLES.map((t) => t.number),
        chapters: [
          { title: 40, chapter: 'I' },
          { title: 42, chapter: 'I' },
        ],
        parts: [
          { title: 40, part: '60', subpart: null },
          { title: 40, part: '63', subpart: null },
          { title: 42, part: '136', subpart: null },
          { title: 42, part: '136', subpart: 'A' },
          { title: 42, part: '136', subpart: 'B' },
        ],
      });
    },

    listAgencies() {
      return Promise.resolve(AGENCIES);
    },

    getAgency(slug): Promise<AgencyPage | null> {
      const base = byslug.get(slug);
      if (!base) return Promise.resolve(null);

      const scopesFor: Record<string, AgencyPage['scopes']> = {
        [EPA.slug]: [
          {
            ref_key: 'title-40/chapter-I',
            title: 40,
            subtitle: null,
            chapter: 'I',
            subchapter: null,
            part: null,
            narrowest_level: 'chapter',
            display: '40 CFR Chapter I',
            ecfr_url: 'https://www.ecfr.gov/current/title-40/chapter-I',
            word_count: rolled(1_284_512),
            label: 'Environmental Protection Agency',
            node_citation: 'title-40/chapter-I',
            shared_with: [],
          },
        ],
        [OAR.slug]: [
          {
            // The 12-of-487 case: names a chapter AND a narrower part. The narrowest wins.
            ref_key: 'title-40/chapter-I/part-60',
            title: 40,
            subtitle: null,
            chapter: 'I',
            subchapter: null,
            part: '60',
            narrowest_level: 'part',
            display: '40 CFR Part 60',
            ecfr_url: 'https://www.ecfr.gov/current/title-40/chapter-I/part-60',
            word_count: counted(127_491),
            label: 'Standards of Performance for New Stationary Sources',
            node_citation: 'title-40/chapter-I/subchapter-C/part-60',
            shared_with: [],
          },
        ],
        [IHS.slug]: [
          {
            ref_key: 'title-42/chapter-I',
            title: 42,
            subtitle: null,
            chapter: 'I',
            subchapter: null,
            part: null,
            narrowest_level: 'chapter',
            display: '42 CFR Chapter I',
            ecfr_url: 'https://www.ecfr.gov/current/title-42/chapter-I',
            word_count: rolled(486_220),
            label: 'Public Health Service, Department of Health and Human Services',
            node_citation: 'title-42/chapter-I',
            shared_with: [PHS],
          },
        ],
        [PHS.slug]: [
          {
            ref_key: 'title-42/chapter-I',
            title: 42,
            subtitle: null,
            chapter: 'I',
            subchapter: null,
            part: null,
            narrowest_level: 'chapter',
            display: '42 CFR Chapter I',
            ecfr_url: 'https://www.ecfr.gov/current/title-42/chapter-I',
            word_count: rolled(486_220),
            label: 'Public Health Service, Department of Health and Human Services',
            node_citation: 'title-42/chapter-I',
            shared_with: [IHS],
          },
          {
            ref_key: 'title-42/chapter-IV',
            title: 42,
            subtitle: null,
            chapter: 'IV',
            subchapter: null,
            part: null,
            narrowest_level: 'chapter',
            display: '42 CFR Chapter IV',
            ecfr_url: 'https://www.ecfr.gov/current/title-42/chapter-IV',
            word_count: unknown(
              'unavailable_fetch_failed',
              'eCFR returned HTTP 504 after the retry budget was exhausted',
            ),
            label: null,
            node_citation: null,
            shared_with: [],
          },
        ],
      };

      const buckets = fixtureBuckets(slug.length);
      return Promise.resolve({
        ...base,
        parent: base.parent_slug ? EPA : null,
        children: AGENCIES.filter((a) => a.parent_slug === slug),
        scopes: scopesFor[slug] ?? [],
        amendments: {
          buckets,
          total: buckets.reduce((sum, b) => sum + b.count, 0),
          unattributable: 3,
          from: buckets[0]?.month ?? null,
          to: buckets.at(-1)?.month ?? null,
        },
        history: [],
      });
    },

    listTitles() {
      return Promise.resolve(TITLES);
    },

    getTitle(titleNumber): Promise<TitlePage | null> {
      const t = TITLES.find((row) => row.number === titleNumber);
      if (!t) return Promise.resolve(null);

      const chapters =
        titleNumber === 40
          ? [
              {
                citation: 'title-40/chapter-I',
                identifier: 'I',
                label: 'Environmental Protection Agency',
                reserved: false,
                word_count: rolled(1_412_003),
                parts: 2,
                agencies: [EPA, OAR],
              },
            ]
          : titleNumber === 42
            ? [
                {
                  citation: 'title-42/chapter-I',
                  identifier: 'I',
                  label: 'Public Health Service, Department of Health and Human Services',
                  reserved: false,
                  word_count: rolled(486_220),
                  parts: 1,
                  agencies: [IHS, PHS],
                },
              ]
            : [];

      return Promise.resolve({
        ...t,
        chapter_list: chapters,
        subtitles: [],
        agencies: titleNumber === 40 ? [EPA, OAR] : titleNumber === 42 ? [IHS, PHS] : [],
      });
    },

    async getChapter(titleNumber, chapterId): Promise<ChapterPage | null> {
      const page = await api.getTitle(titleNumber);
      const chapter = page?.chapter_list.find((c) => c.identifier === chapterId);
      if (!page || !chapter) return null;

      const parts = [...PARTS.entries()]
        .filter(([key]) => key.startsWith(`${titleNumber}/`) && key.endsWith('/'))
        .map(([, p]) => ({
          citation: p.citation,
          identifier: p.identifier,
          label: p.label,
          reserved: p.reserved,
          word_count: p.word_count,
          sections: p.sections,
        }));

      return {
        ...chapter,
        title_number: titleNumber,
        title_name: page.name,
        ecfr_url: `https://www.ecfr.gov/current/title-${titleNumber}/chapter-${chapterId}`,
        display: `${titleNumber} CFR Chapter ${chapterId}`,
        groups: [
          {
            identifier: titleNumber === 40 ? 'C' : null,
            label: titleNumber === 40 ? 'Air Programs' : null,
            part_list: parts,
          },
        ],
      };
    },

    getPart(titleNumber, partId, subpart): Promise<PartView | null> {
      return Promise.resolve(PARTS.get(`${titleNumber}/${partId}/${subpart ?? ''}`) ?? null);
    },

    listSharedScopes() {
      return Promise.resolve(SHARED);
    },

    getDataQuality() {
      return Promise.resolve({
        nodes_total: 13,
        nodes_known: 9,
        nodes_unknown: 4,
        groups: [
          {
            status: 'unavailable_fetch_failed',
            count: 2,
            reasons: [
              { reason: 'eCFR returned HTTP 504 after the retry budget was exhausted', count: 2 },
            ],
            sample: [
              {
                citation: 'title-42/chapter-IV',
                title_number: 42,
                node_type: 'chapter',
                label: null,
                reason: 'eCFR returned HTTP 504 after the retry budget was exhausted',
              },
            ],
            sample_truncated: true,
          },
          {
            status: 'unavailable_too_large',
            count: 1,
            reasons: [
              {
                reason:
                  'the part exceeds the per-node processing ceiling and was skipped rather than counted partially',
                count: 1,
              },
            ],
            sample: [
              {
                citation: 'title-40/chapter-I/subchapter-C/part-63',
                title_number: 40,
                node_type: 'part',
                label: 'National Emission Standards for Hazardous Air Pollutants',
                reason:
                  'the part exceeds the per-node processing ceiling and was skipped rather than counted partially',
              },
            ],
            sample_truncated: false,
          },
          {
            status: 'not_computed',
            count: 1,
            reasons: [{ reason: REASON_NOT_COMPUTED, count: 1 }],
            sample: [
              {
                citation: 'title-42/chapter-I/part-136/subpart-B',
                title_number: 42,
                node_type: 'subpart',
                label: 'Eligibility',
                reason: REASON_NOT_COMPUTED,
              },
            ],
            sample_truncated: false,
          },
        ],
        by_title: [
          { title_number: 42, title_name: 'Public Health', unknown: 3, total: 7 },
          { title_number: 40, title_name: 'Protection of Environment', unknown: 1, total: 6 },
        ],
        partial_agencies: [
          {
            slug: PHS.slug,
            display_name: PHS.display_name,
            coverage: { refs_total: 2, refs_counted: 1, pct: 0.5 },
          },
        ],
        unresolved_refs: [
          { ref_key: 'title-42/chapter-IV', display: '42 CFR Chapter IV', agencies: [PHS] },
        ],
      });
    },

    getAmendmentActivity() {
      const buckets = fixtureBuckets(7);
      return Promise.resolve({
        buckets,
        total: buckets.reduce((sum, b) => sum + b.count, 0),
        unattributable: 0,
        from: buckets[0]?.month ?? null,
        to: buckets.at(-1)?.month ?? null,
      });
    },
  };

  return api;
}
