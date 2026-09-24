// GENERATED FILE — do not edit by hand.
// Source: scripts/build-questions.ts (npm run build:questions)

/** Stable slug ids for the 10 upstream question categories. */
export const CATEGORY_IDS = [
  'constitution',
  'democracy-politics',
  'economy-employment',
  'education-religion',
  'elections',
  'federal-system',
  'general',
  'history-geography',
  'law-governance',
  'rights-freedoms',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

/** Slug -> original upstream English category label. */
export const CATEGORY_LABELS: Record<CategoryId, string> = {
  'constitution': 'Constitution',
  'democracy-politics': 'Democracy & Politics',
  'economy-employment': 'Economy & Employment',
  'education-religion': 'Education & Religion',
  'elections': 'Elections',
  'federal-system': 'Federal System',
  'general': 'General',
  'history-geography': 'History & Geography',
  'law-governance': 'Law & Governance',
  'rights-freedoms': 'Rights & Freedoms',
};

/**
 * Number of shipped questions per category (informational).
 * Total: 460 records.
 */
export const CATEGORY_COUNTS: Record<CategoryId, number> = {
  'constitution': 14,
  'democracy-politics': 9,
  'economy-employment': 9,
  'education-religion': 9,
  'elections': 18,
  'federal-system': 11,
  'general': 229,
  'history-geography': 126,
  'law-governance': 33,
  'rights-freedoms': 2,
};

export function isCategoryId(value: string): value is CategoryId {
  return (CATEGORY_IDS as readonly string[]).includes(value);
}
