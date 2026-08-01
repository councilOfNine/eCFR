/**
 * The single source of truth for every internal URL.
 *
 * The snapshot contract deliberately carries no `href` fields. If it did, the exporter and the
 * site would each hold an opinion about URL shape and the two would drift — a broken link is a
 * cheap bug, but a link that silently points at the wrong scope is the same class of error as a
 * mis-attributed word count.
 */

/**
 * Accepts both core's `Scope` (absent levels are `undefined`) and the API/snapshot scope shape
 * (absent levels are `null`). One function for both spellings, because a URL builder that only
 * took one of them would get an `as` cast at every call site — and a cast is where a wrong link
 * gets in.
 */
export interface ScopeParts {
  title: number;
  subtitle?: string | null;
  chapter?: string | null;
  subchapter?: string | null;
  part?: string | null;
}

/**
 * CFR identifiers are not all URL-safe integers: parts include forms like `50a` and `1926`,
 * chapters are Roman numerals, and appendix-bearing identifiers can carry punctuation.
 * Encoding here rather than at each call site means a new identifier shape cannot produce a
 * malformed path.
 */
const seg = (value: string | number): string => encodeURIComponent(String(value));

export const home = (): string => '/';
export const agencyIndex = (): string => '/agency';
export const titleIndex = (): string => '/title';
export const sharedJurisdiction = (): string => '/shared-jurisdiction';
export const methodology = (): string => '/methodology';
export const dataQuality = (): string => '/data-quality';
export const apiPage = (): string => '/api';
export const about = (): string => '/about';
export const glossary = (): string => '/glossary';
export const faq = (): string => '/faq';

export const agency = (slug: string): string => `/agency/${seg(slug)}`;
export const title = (n: number): string => `/title/${seg(n)}`;
export const chapter = (n: number, chapterId: string): string =>
  `/title/${seg(n)}/chapter/${seg(chapterId)}`;

export function part(n: number, partId: string, subpart: string | null = null): string {
  const base = `/title/${seg(n)}/part/${seg(partId)}`;
  return subpart === null ? base : `${base}/${seg(subpart)}`;
}

/**
 * Best internal page for an agency's CFR reference.
 *
 * There are no subtitle or subchapter pages — those levels exist in the structure but have no
 * standalone content worth a route — so a reference at either level resolves to its nearest
 * ancestor that does have one. It returns the ancestor, never null, so a scope is always
 * navigable; the page it lands on shows the full citation, which is what a researcher needs to
 * carry into a filing.
 */
export function scopeHref(scope: ScopeParts): string {
  if (scope.part) return part(scope.title, scope.part);
  if (scope.chapter) return chapter(scope.title, scope.chapter);
  return title(scope.title);
}

/**
 * True when the page a scope links to represents the scope exactly, rather than a broader
 * ancestor. The UI marks the inexact cases so a user is not misled into thinking the chapter
 * page they landed on is the subchapter they clicked.
 */
export function scopeHrefIsExact(scope: ScopeParts): boolean {
  if (scope.part) return true;
  if (scope.subchapter) return false;
  if (scope.chapter) return true;
  if (scope.subtitle) return false;
  return true;
}

/** Stable in-page fragment for a section within the reader. */
export function sectionAnchor(identifier: string): string {
  // Section identifiers contain dots (`60.1`) and occasionally other punctuation. `CSS.escape`
  // is not available in Node, and a dot in an id breaks naive querySelector use downstream, so
  // non-word characters collapse to a hyphen.
  return `s-${identifier.replace(/[^\w.-]+/g, '-')}`;
}
