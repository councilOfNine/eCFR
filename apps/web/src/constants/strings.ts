/**
 * Every user-facing string the site's chrome renders, in one module, structured by
 * page/component. Prep for i18n: a translation is a second file with this shape, and a page
 * that never spells its own copy inline cannot ship an untranslatable literal.
 *
 * WHAT DOES NOT LIVE HERE, deliberately:
 *
 *   - Long-form editorial prose whose sentences interleave inline markup (links, <code>,
 *     <strong>) — the /methodology and /about essays and the explanatory paragraphs modelled on
 *     them. Splitting a sentence around its markup into string fragments is the classic i18n
 *     mistake (fragments cannot be reordered per language), and it makes the prose unreadable
 *     at its source. Those paragraphs stay in their .astro files; their headings and labels are
 *     here.
 *   - Strings that travel INSIDE the data contract (`WordCount.reason`,
 *     `content_unavailable_reason`, node labels). Those are data the UI renders verbatim, they
 *     are produced by exporters outside apps/web, and contract.ts documents their conventions.
 *
 * Parameterised entries are template functions. Parameters typed `string` expect an
 * already-formatted value (formatInt/formatPct/formatDate output); `number` means the raw
 * figure is interpolated unformatted, exactly as the original markup did.
 *
 * WORDING IS LOAD-BEARING. scripts/check-html.ts asserts every `data-unmeasured` marker is
 * paired with the exact phrase "Not measured" — grep the checks before editing anything here.
 */

import type { UnknownStatus, WordCountStatus } from '@ecfr-atlas/core';

export const STRINGS = {
  common: {
    /** The one honest word for an absent measurement. Asserted by scripts/check-html.ts. */
    notMeasured: 'Not measured',
    /** Placeholder for an absent non-measurement value (a null date). Never used for counts. */
    missingValue: '—',
    wordsUnit: 'words',
    reservedBadge: 'reserved',
    reservedHeading: '[Reserved]',
    officialTextLink: 'Official text on eCFR ↗',
    ecfrLink: 'eCFR ↗',
    readOnEcfrLink: 'Read on eCFR ↗',
    detailsLink: 'Details →',
    methodologyLink: 'Methodology →',
  },

  a11y: {
    skipToMain: 'Skip to main content',
    /** aria-label of the primary nav. Asserted verbatim by scripts/check-html.ts. */
    primaryNav: 'Primary',
    breadcrumbNav: 'Breadcrumb',
    footerNav: 'Footer',
    projectNav: 'Project',
  },

  banner: {
    fixture:
      'Fixture build — every figure on this site is invented sample data, not a measurement.',
  },

  header: {
    nav: {
      dashboard: 'Dashboard',
      agencies: 'Agencies',
      titles: 'Titles',
      shared: 'Shared jurisdiction',
      quality: 'Data quality',
      methodology: 'Methodology',
      api: 'API',
    },
    /** Precedes the <time> element carrying the snapshot date. */
    sourceDatePrefix: 'eCFR as of',
  },

  footer: {
    notOfficialEyebrow: 'Not an official edition',
    independence:
      'eCFR Atlas is an independent, open-source project. It is not affiliated with, endorsed ' +
      'by, or an official publication of the United States Government. The Electronic Code of ' +
      'Federal Regulations is produced by the Office of the Federal Register and the Government ' +
      'Publishing Office; it is itself an unofficial editorial compilation, and only the annual ' +
      'printed CFR and the Federal Register are authoritative for legal purposes.',
    exploreEyebrow: 'Explore',
    projectEyebrow: 'Project',
    links: {
      agencies: 'Agencies',
      titles: 'CFR titles',
      shared: 'Shared jurisdiction',
      quality: 'Data quality',
      methodology: 'Methodology',
      api: 'Public API',
      about: 'About & attribution',
      officialEcfr: 'Official eCFR ↗',
    },
    fixtureLine: 'Fixture build — no eCFR data was read.',
    dataAsOf: (date: string) => `Data reflects the eCFR as of ${date}.`,
    sourceDateUnknown: 'Source date unknown for this build.',
    /** Leading space matches the conditional interpolation it replaces. */
    syncRun: (runId: number) => ` Sync run #${runId}.`,
  },

  wordCount: {
    unmeasured: 'Not measured',
  },

  coverageBadge: {
    noScopes: 'No CFR scopes',
    measured: (counted: number, total: number, pct: string) =>
      `${counted} of ${total} scopes measured (${pct})`,
    zeroScopes: '0 scopes',
    ratio: (counted: number, total: number) => `${counted}/${total}`,
  },

  copyCitation: {
    currentAsOf: (date: string) => `(current as of ${date})`,
    copyButton: 'Copy citation',
    copied: 'Copied.',
    blocked: 'Copy blocked by the browser — select the citation instead.',
  },

  themeToggle: {
    system: 'Theme: system',
    light: 'Theme: light',
    dark: 'Theme: dark',
  },

  barChart: {
    barLabelKnown: (label: string, words: string) => `${label}: ${words} words`,
    barLabelUnknown: (label: string, reason: string) => `${label}: not measured. ${reason}`,
  },

  amendmentTimeline: {
    /** Trailing comma matches the sentence it opens: "1,204 amendments, Jan 2025 – Mar 2026". */
    total: (count: string) => `${count} amendments,`,
    monthDetail: (month: string, count: string) => `${month}: ${count} amendments`,
    empty: 'No amendment history is recorded for this build.',
    unattributable: (count: string) =>
      `${count} further amendments in these titles carry no part identifier and cannot be ` +
      'attributed to a specific scope, so they are excluded from the chart rather than assigned ' +
      'to one.',
  },

  partToc: {
    heading: 'Sections',
    count: (n: number) => `(${n})`,
    empty: 'No sections are recorded for this part.',
  },

  agencyTable: {
    defaultCaption: 'Agencies by deduplicated word count',
    columns: {
      agency: 'Agency',
      deduplicated: 'Deduplicated',
      attributed: 'Attributed',
      scopes: 'Scopes',
      coverage: 'Coverage',
    },
    sharedBadge: (n: number) => `shared ×${n}`,
    sharedBadgeTitle: (n: number) =>
      `${n} of this agency's scopes are co-claimed by another agency`,
    sortNote:
      'Default order is deduplicated word count, highest first. Agencies whose total could not ' +
      'be measured sort last in both directions — they are not zero.',
    unmeasuredNote: (unmeasured: string, total: string) =>
      `${unmeasured} of ${total} agencies have no measured total in this build.`,
    filterPlaceholder: 'Filter agencies…',
    filterLabel: 'Filter agencies by name',
    /**
     * Token pattern, not a function: the substitution happens in the client script, which reads
     * this from a data attribute so the strings bundle never ships to the browser.
     */
    filterStatusPattern: '{shown} of {total} agencies',
  },

  /**
   * Presentation copy for the measurement statuses. Typed against core's unions so adding a
   * status to WORD_COUNT_STATUSES breaks this file until the copy exists — a status the UI
   * cannot explain must not be renderable.
   */
  status: {
    labels: {
      counted: 'Measured directly',
      rolled_up: 'Summed from measured parts',
      reserved_empty: 'Reserved — genuinely empty',
      structurally_empty: 'Heading only — no regulatory text',
      stale: 'Measured, awaiting recount',
      not_computed: 'Not yet computed',
      unavailable_fetch_failed: 'Source fetch failed',
      unavailable_parse_failed: 'Could not be parsed',
      unavailable_too_large: 'Skipped — above the processing ceiling',
    } satisfies Record<WordCountStatus, string>,
    /** Longer copy for /data-quality and /methodology, one section per unknown status. */
    explanations: {
      not_computed:
        'The node is in scope but no sync run has reached it yet. It will resolve on a ' +
        'subsequent run without any intervention.',
      unavailable_fetch_failed:
        'eCFR did not return the XML within the retry budget. Two distinct upstream failures ' +
        'produce this: a token-bucket 429, and a gateway timeout at about 50 seconds when the ' +
        'origin takes too long to generate a large title. The second is closer to a coin flip ' +
        'than an error — isolated fetches of title 49 failed twice in four attempts.',
      unavailable_parse_failed:
        'The XML came back but could not be parsed into a countable subtree. Every one of these ' +
        'is a bug on our side, not upstream, and is worth reporting.',
      unavailable_too_large:
        'The node exceeds the per-node processing ceiling and was skipped on purpose rather ' +
        'than processed partially. A partial count would look like a plausible number.',
    } satisfies Record<UnknownStatus, string>,
  },

  dashboard: {
    description:
      'A measured atlas of the US Code of Federal Regulations: word counts by agency and ' +
      'title, shared jurisdiction, and full regulation text — with every unmeasured value ' +
      'marked as unmeasured.',
    eyebrow: 'Code of Federal Regulations',
    heading: 'How much regulation, and whose?',
    intro:
      "Every figure here is a measurement taken by parsing the eCFR's own XML. Where a value " +
      'could not be measured it appears as an em dash carrying the reason, never as zero.',
    /** Leading space: appended to the intro sentence inside the same paragraph. */
    currentAsOf: (date: string) => ` Current as of ${date}.`,
    totalsHeading: 'Corpus totals',
    deduplicated: {
      eyebrow: 'Deduplicated words in the CFR',
      note:
        'Each scope counted exactly once. Where two or more agencies administer the same ' +
        'scope, its words are divided evenly between them, so the agency totals sum back to ' +
        'the corpus. This is the honest answer to “how big is the CFR?”.',
    },
    attributed: { eyebrow: 'Attributed words' },
    shared: {
      eyebrow: 'Words under shared jurisdiction',
      scopeCount: (n: string) => `${n} scopes are claimed by more than one agency`,
      corpusShare: (pct: string) => ` — ${pct} of the corpus`,
      link: 'See who shares what →',
    },
    glanceLabel: 'Corpus at a glance',
    stats: {
      agencies: 'Agencies',
      titles: 'Titles',
      titlesNote: (reserved: number) => `${reserved} reserved and therefore empty by definition.`,
      parts: 'Parts',
      partsNote: (sections: string, chapters: string) =>
        `${sections} sections across ${chapters} chapters.`,
      unmeasured: 'Unmeasured nodes',
      unmeasuredNote: (total: string) =>
        `Of ${total} structure nodes. Every one is listed with its reason.`,
    },
    rankingHeading: 'Largest agencies by deduplicated words',
    rankingCaption: 'Top 12 agencies',
    noRankingTitle: 'No agency has a measured total in this build',
    timelineCaption: 'Amendments published, all titles',
    sharedCalloutTitle: 'Shared jurisdiction is a feature of the data',
    allAgenciesHeading: 'All agencies',
    agencyCount: (n: string) => `${n} agencies and sub-agencies.`,
    howCountedLink: 'How these are counted →',
  },

  agencyIndex: {
    title: 'Agencies',
    description:
      'Every federal agency and sub-agency with CFR references, with measured deduplicated ' +
      'and attributed word counts and scope coverage.',
    eyebrow: 'Directory',
    standfirst: (agencies: string, parents: string) =>
      `${agencies} agencies and sub-agencies hold CFR references — ${parents} at the top ` +
      'level. Sort by any column; filter by name. Agencies whose totals could not be measured ' +
      'sort last rather than as zero.',
    caption: 'All agencies with CFR references',
  },

  agencyDetail: {
    description: (name: string) =>
      `CFR scopes administered by ${name}, with measured word counts, shared jurisdiction, ` +
      'and amendment activity.',
    breadcrumbRoot: 'Agencies',
    subAgencyEyebrow: (parent: string) => `Sub-agency of ${parent}`,
    agencyEyebrow: 'Federal agency',
    cardsLabel: 'Word counts',
    deduplicated: {
      eyebrow: 'Deduplicated',
      note: 'Shared scopes divided evenly between claimants.',
    },
    attributed: {
      eyebrow: 'Attributed',
      note: 'Shared scopes counted in full. Do not sum this across agencies.',
    },
    subtree: {
      eyebrow: 'Including sub-agencies',
      noChildren: 'This agency has no sub-agencies, so this equals its own total.',
      rolledUp: (children: string) => `Rolled up across ${children} sub-agencies.`,
    },
    scopes: {
      eyebrow: 'CFR scopes',
      measured: (n: string) => `${n} measured`,
      shared: (n: string) => `, ${n} shared`,
    },
    sharedCalloutTitle: 'Shared jurisdiction',
    sharedCallout: (n: string) =>
      `${n} of this agency's scopes are administered jointly with another agency. Its ` +
      'deduplicated total divides those words evenly among the claimants; its attributed total ' +
      'counts them in full.',
    /** Joins a scope to its co-claimants inside the list item, hence the surrounding spaces. */
    sharedWith: 'with',
    allSharedLink: 'All shared scopes across the CFR →',
    unresolvedCalloutTitle: 'Unresolved references',
    scopesHeading: 'CFR scopes administered',
    noScopes: 'eCFR records no CFR references for this agency.',
    columns: {
      citation: 'Citation',
      scope: 'Scope',
      level: 'Level',
      words: 'Words',
      alsoAdministered: 'Also administered by',
      officialText: 'Official text',
    },
    unresolvedScope: 'not resolved to a structure node',
    levelNote:
      '“Level” is the narrowest level the reference actually names. A reference that names ' +
      'both a chapter and a part is a part-level reference and is counted as one.',
    childrenHeading: 'Sub-agencies',
    activityHeading: 'Amendment activity',
    activityCaption: (name: string) => `Sections amended in parts administered by ${name}`,
    activityNote:
      'Attribution is exact, not estimated: each scope is expanded to the set of parts inside ' +
      'it in the current structure, and only amendments to those parts are counted. Dated by ' +
      'issue date, not amendment date — the two differ in about half of all rows.',
  },

  titleIndex: {
    title: 'CFR titles',
    description:
      'All titles of the Code of Federal Regulations with measured word counts, chapter and ' +
      'part counts, and the date each was last amended.',
    eyebrow: 'Browse',
    standfirst: (active: string) =>
      `${active} titles carry regulation text. Reserved titles are shown with a measured ` +
      'zero, which is the one place on this site where zero is the honest answer.',
    caption: 'CFR titles with word counts and amendment dates',
    columns: {
      number: '#',
      title: 'Title',
      words: 'Words',
      chapters: 'Chapters',
      parts: 'Parts',
      sections: 'Sections',
      lastAmended: 'Last amended',
    },
  },

  titlePage: {
    title: (number: number, name: string) => `Title ${number} — ${name}`,
    description: (number: number, name: string) =>
      `Title ${number} of the Code of Federal Regulations: ${name}. Chapter list with ` +
      'measured word counts and the agencies that administer each.',
    breadcrumbRoot: 'Titles',
    breadcrumbTitle: (number: number) => `Title ${number}`,
    reservedCalloutTitle: 'This title is reserved',
    reservedCallout: (number: number) =>
      `Title ${number} is reserved in the CFR: it has no chapters, no parts and no text. Its ` +
      'word count is a measured zero rather than an unknown, and eCFR publishes no amendment ' +
      'or issue dates for it.',
    summaryLabel: 'Title summary',
    words: 'Words',
    structure: 'Structure',
    structureNote: (parts: string, sections: string) =>
      `chapters · ${parts} parts · ${sections} sections`,
    lastAmended: 'Last amended',
    issued: 'Issued',
    agencies: 'Agencies',
    agenciesNote: 'hold references inside this title',
    administeredBy: 'Administered by',
    chaptersHeading: 'Chapters',
    noChapters: 'This title has no chapters recorded.',
    subtitleHeading: (identifier: string, label: string) => `Subtitle ${identifier} — ${label}`,
    chapterLink: (identifier: string, label: string) => `Chapter ${identifier} — ${label}`,
    partCount: (parts: string) => `${parts} parts`,
  },

  chapterPage: {
    title: (display: string, label: string) => `${display} — ${label}`,
    description: (display: string, label: string) =>
      `${display}: ${label}. Table of contents with measured word counts for every part.`,
    breadcrumbRoot: 'Titles',
    breadcrumbTitle: (number: number) => `Title ${number}`,
    breadcrumbChapter: (identifier: string) => `Chapter ${identifier}`,
    partCount: (parts: string) => `${parts} parts`,
    agenciesHeading: 'Agencies with references in this chapter',
    partsHeading: 'Parts',
    noParts: 'No parts are recorded under this chapter.',
    subchapterHeading: (identifier: string) => `Subchapter ${identifier}`,
    subchapterLabel: (label: string) => ` — ${label}`,
    columns: { part: 'Part', heading: 'Heading', sections: 'Sections', words: 'Words' },
  },

  partPage: {
    title: (display: string, label: string) => `${display} — ${label}`,
    description: (display: string, label: string) =>
      `${display}: ${label}. Full regulation text, table of contents, authority and source ` +
      'notes, and measured word counts.',
    breadcrumbRoot: 'Titles',
    breadcrumbTitle: (number: number) => `Title ${number}`,
    breadcrumbChapter: (identifier: string) => `Chapter ${identifier}`,
    breadcrumbPart: (identifier: string) => `Part ${identifier}`,
    breadcrumbSubpart: (identifier: string) => `Subpart ${identifier}`,
    reservedHeading: (display: string) => `${display} [Reserved]`,
    subpartEyebrow: (identifier: string) => ` · Subpart ${identifier}`,
    chapterLine: (identifier: string, label: string) => ` · Chapter ${identifier}, ${label}`,
    subchapterLine: (identifier: string) => ` · Subchapter ${identifier}`,
    citationWithSubpart: (display: string, subpart: string) => `${display}, Subpart ${subpart}`,
    words: 'Words',
    sections: 'Sections',
    lastAmended: 'Last amended',
    administeredBy: 'Administered by',
    authorityHeading: 'Authority and source',
    authority: 'Authority',
    source: 'Source',
    editorialNote: 'Editorial note',
    sliceCalloutTitle: 'This part is published in slices',
    sliceFallbackReason:
      'The full text of this part is too large to serve as one page, so it is split by subpart.',
    noContentTitle: 'Regulation text is not in this build',
    noContentFallbackReason: 'No rendered text is available for this part in the current build.',
    reservedCalloutTitle: 'Reserved',
    reservedCallout:
      'This part is reserved in the CFR. It has no text, and its word count is a measured ' +
      'zero rather than an unknown.',
    subpartsNav: 'Subparts',
    boilerplateNote:
      'Word counts exclude heading, authority, source, citation and table-of-contents ' +
      'boilerplate — measured at 18.4% of the text in a sample chapter.',
  },

  sharedJurisdiction: {
    title: 'Shared jurisdiction',
    description:
      'CFR scopes administered by more than one federal agency, ranked by word count, with ' +
      'every claimant named.',
    eyebrow: 'Overlap',
    heading: 'Scopes with more than one agency',
    standfirst:
      'Some parts of the CFR are administered jointly. Counting those scopes once per ' +
      'claimant inflates any corpus total that sums agencies, so this site publishes both a ' +
      'deduplicated total and an attributed one — and lists every overlap here.',
    summaryLabel: 'Overlap summary',
    scopesCard: {
      eyebrow: 'Shared scopes',
      note: (refsTotal: string) => `of ${refsTotal} agency references`,
    },
    wordsCard: {
      eyebrow: 'Words under shared jurisdiction',
      note: (pct: string) => `${pct} of the deduplicated corpus`,
    },
    agenciesCard: {
      eyebrow: 'Agencies involved',
      note: (claims: string, scopes: string) => `${claims} claims across ${scopes} scopes`,
    },
    maxCard: {
      eyebrow: 'Most claimants on one scope',
      note: 'agencies on a single scope',
    },
    divisionCalloutTitle: 'How a shared scope is divided',
    scopesHeading: 'Every shared scope',
    rankNote: 'Ranked by word count.',
    unmeasuredNote: (n: string) => ` ${n} could not be measured and are listed last.`,
    empty: 'No scope in this dataset is claimed by more than one agency.',
    caption: 'CFR scopes claimed by more than one agency',
    columns: {
      citation: 'Citation',
      scope: 'Scope',
      words: 'Words',
      claimants: 'Claimants',
      agencies: 'Agencies',
      officialText: 'Official text',
    },
  },

  dataQuality: {
    title: 'Data quality',
    description:
      'Every CFR node whose word count could not be measured, grouped by reason and counted ' +
      '— plus agencies with partial coverage and references that no longer resolve.',
    eyebrow: 'Transparency',
    standfirst:
      'What this dataset does not know, stated in full. Nothing here is hidden behind a zero.',
    summaryLabel: 'Coverage summary',
    measuredCard: {
      eyebrow: 'Structure nodes measured',
      note: (known: string, total: string) => `${known} of ${total}`,
    },
    unmeasuredCard: {
      eyebrow: 'Unmeasured nodes',
      note: (causes: string) => `across ${causes} distinct causes`,
    },
    partialCard: {
      eyebrow: 'Agencies below full coverage',
      note: 'their totals are reported as unmeasured, not as partial sums',
    },
    unresolvedCard: {
      eyebrow: 'Unresolved references',
      note: 'point at a scope not in the current structure',
    },
    partialCalloutTitle: 'Why a partial total is reported as no total',
    partialCallout:
      'When one descendant of a node cannot be measured, this site reports the parent as ' +
      'unmeasured rather than summing what it has. A partial sum is wrong in the one direction ' +
      'that hides itself: it under-reports, and an under-report looks like a plausible figure. ' +
      'An em dash does not.',
    reasonsHeading: 'Unmeasured nodes by reason',
    allMeasured: 'Every structure node in this build carries a measured word count.',
    nodeCount: (n: string) => `${n} nodes`,
    reasonsRecorded: 'Reasons recorded',
    examples: 'Examples',
    truncatedExamples: (shown: string, total: string) => ` — showing ${shown} of ${total}`,
    sampleColumns: { citation: 'Citation', type: 'Type', heading: 'Heading', title: 'Title' },
    byTitleHeading: 'Titles with unmeasured nodes',
    byTitleIntro:
      'A title concentrated at the top of this list usually means one large fetch or parse ' +
      'failure rather than many small ones — worth checking before trusting any figure derived ' +
      'from it.',
    byTitleColumns: {
      title: 'Title',
      name: 'Name',
      unmeasured: 'Unmeasured',
      total: 'Total nodes',
      share: 'Share',
    },
    partialHeading: 'Agencies with partial scope coverage',
    partialColumns: { agency: 'Agency', measured: 'Scopes measured', coverage: 'Coverage' },
    unresolvedHeading: 'Unresolved references',
    unresolvedIntro:
      'eCFR lists these scopes against an agency, but no node matching them exists in the ' +
      'current structure — usually a scope that has been removed or renumbered upstream while ' +
      'the agency record still points at it. They are shown rather than dropped, because a ' +
      'silently discarded reference is an agency total that is quietly too small.',
    unresolvedColumns: { citation: 'Citation', refKey: 'ref_key', claimedBy: 'Claimed by' },
  },

  apiPage: {
    title: 'API',
    description:
      'Public JSON API for the eCFR Atlas: agency and title word counts, CFR structure, ' +
      'amendments, shared jurisdiction, and section diffs. Anonymous access allowed; free API ' +
      'keys raise the limit.',
    eyebrow: 'For machines',
    heading: 'Public API',
    standfirst:
      'Everything on this site is available as JSON, under the same measurement rules. ' +
      'Anonymous requests work immediately at a low rate limit so the docs are explorable ' +
      'without signing up.',
    docsLink: 'Interactive docs ↗',
    openapiLink: 'OpenAPI 3.1 document ↗',
    envelopeCalloutTitle: 'Read this before you sum anything',
    endpointsHeading: 'Endpoints',
    endpointsIntro: (n: number) =>
      `All ${n} of them. This table is generated at build time from the route definitions in ` +
      "the API's own source, so it cannot drift from what the service actually serves.",
    columns: { method: 'Method', path: 'Path', returns: 'Returns' },
    rateLimitsHeading: 'Rate limits and keys',
    termsHeading: 'Terms of use',
  },

  methodology: {
    title: 'Methodology',
    description:
      'What counts as a word, what is excluded from the counts and why, how shared scopes ' +
      'are divided, and what an unmeasured value means on this site.',
    eyebrow: 'How the numbers are made',
    standfirst:
      "Every word count on this site is produced by parsing the eCFR's own XML. None is " +
      'estimated, extrapolated or inferred from file size. This page states the rules ' +
      'precisely enough to disagree with.',
    headings: {
      whatIsAWord: 'What counts as a word',
      exclusions: 'What is excluded, and why',
      parsing: 'How the text is extracted',
      scopes: 'How agency scopes are resolved',
      sharing: 'How shared scopes are divided',
      rollups: 'How totals are rolled up',
      unknown: 'What “—” means',
      dates: 'Dates',
    },
    oursCalloutTitle: "These numbers are ours, not the government's",
  },

  about: {
    title: 'About',
    description:
      'What the eCFR Atlas is, where its data comes from, who publishes the source material, ' +
      'and the disclaimers that apply to every figure on the site.',
    eyebrow: 'About',
    heading: 'An open, measured atlas of federal regulation',
    standfirst:
      'Built for people researching which agencies carry the most regulation, and for people ' +
      'preparing proposals to change it.',
    headings: {
      whatThisIs: 'What this is',
      dataSource: 'Where the data comes from',
      disclaimers: 'Three disclaimers',
      citing: 'How to cite',
      privacy: 'Privacy',
      contributing: 'Contributing',
    },
    disclaimer1Title: '1. This is not an official edition',
    disclaimer2Title: '2. Neither is the eCFR',
    disclaimer3Title: '3. The word counts are ours',
    buildFromFixture:
      'This particular build was produced from the committed fixture and contains no eCFR ' +
      'data at all.',
    buildAsOf: (date: string) => `This build reflects the eCFR as of ${date}.`,
    buildDateUnknown: 'The source date for this build is not recorded.',
  },

  notFound: {
    title: 'Page not found',
    description: 'That page does not exist on the eCFR Atlas.',
    eyebrow: '404',
    heading: 'That page does not exist',
    standfirst:
      'If you typed a CFR citation, check the title and part numbers — or start from a title ' +
      'and browse down.',
    whereHeading: 'Where to go instead',
    urlShapesHeading: 'URL shapes on this site',
  },
} as const;
