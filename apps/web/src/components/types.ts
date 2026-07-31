/**
 * Prop types shared between components.
 *
 * These live in a .ts module rather than being exported from the .astro files that use them:
 * an Astro component's frontmatter only exposes the component itself (plus `getStaticPaths` and
 * `prerender`), so a type declared there is not importable from a page.
 */

import type { WordCount } from '@ecfr-atlas/core/api-schemas';

import type { SectionEntry } from '../data/contract';

/**
 * WordCount.astro's presentation modes, in the repo's const-object-plus-union shape so the
 * component can dispatch on them exhaustively (see the switch in its frontmatter).
 */
export const WordCountVariant = {
  /** The dashboard's single biggest figure. */
  Headline: 'headline',
  /** Card-sized figures. */
  Lg: 'lg',
  /** Table cells. */
  Default: 'default',
  /** Chart labels and tight cells: "105.1M", full figure in the tooltip. */
  Compact: 'compact',
} as const;

export type WordCountVariant = (typeof WordCountVariant)[keyof typeof WordCountVariant];

export interface BarRow {
  label: string;
  href?: string;
  value: WordCount;
  /** Optional trailing marker, e.g. a shared-jurisdiction pill. */
  note?: string;
}

/** One reader-TOC row, with its link destination already decided by the page. */
export interface PartTocRow {
  section: SectionEntry;
  /** Null renders a plain row: reserved sections, and split-index rows with no known slice. */
  href: string | null;
  /** True only for a same-page fragment; enables data-toc-target and the scroll highlight. */
  samePage: boolean;
}
