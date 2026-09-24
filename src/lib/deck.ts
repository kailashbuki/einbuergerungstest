// Active-deck selection.
//
// The shipped dataset holds 460 records, but a single user only ever studies
// 310 of them: all 300 federal questions plus the 10 questions for the
// Bundesland they picked during onboarding. Every downstream number (readiness,
// drills, the heatmap, badges) must be computed against that 310-question
// active deck and never against all 460, otherwise the totals are wrong for
// every user.
//
// This module is the single place that knows how the raw JSON becomes typed
// `Question` values. It validates the generated data at import time: a bad
// record is a data-build regression and should fail loudly rather than quietly
// produce a 309-question deck.

import rawQuestions from '@/data/questions.json';
import { STATE_CODES, isStateCode, type StateCode } from '@/data/states';
import { isCategoryId } from '@/data/categories';
import { OPTION_KEYS, type OptionKey, type Question, type QuestionId, type QuestionOptions } from '@/types';

/** Federal questions shared by every user. */
export const FEDERAL_DECK_SIZE = 300;
/** Per-state questions; the official test draws 3 of these 10. */
export const STATE_DECK_SIZE = 10;
/** What a single user actually studies. */
export const ACTIVE_DECK_SIZE = FEDERAL_DECK_SIZE + STATE_DECK_SIZE;

/* ───────────────────────────── parsing ───────────────────────────── */

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(where: string, message: string): never {
  throw new Error(`questions.json: ${where} ${message}`);
}

function readString(rec: Readonly<Record<string, unknown>>, key: string, where: string): string {
  const value = rec[key];
  if (typeof value !== 'string' || value.length === 0) fail(where, `is missing a non-empty string "${key}"`);
  return value;
}

function readOptionalString(
  rec: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): string | undefined {
  const value = rec[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) fail(where, `has a non-string "${key}"`);
  return value;
}

function readOptions(rec: Readonly<Record<string, unknown>>, where: string): QuestionOptions {
  const raw = rec['options'];
  if (!isRecord(raw)) fail(where, 'is missing "options"');
  const a = readString(raw, 'a', `${where}.options`);
  const b = readString(raw, 'b', `${where}.options`);
  const c = readString(raw, 'c', `${where}.options`);
  const d = readString(raw, 'd', `${where}.options`);
  return { a, b, c, d };
}

function isOptionKey(value: string): value is OptionKey {
  return (OPTION_KEYS as readonly string[]).includes(value);
}

function parseQuestion(value: unknown, index: number): Question {
  if (!isRecord(value)) fail(`record #${index}`, 'is not an object');
  const id = readString(value, 'id', `record #${index}`);

  const number = value['number'];
  if (typeof number !== 'number' || !Number.isInteger(number)) fail(id, 'has a non-integer "number"');

  const scope = readString(value, 'scope', id);
  if (scope !== 'federal' && scope !== 'state') fail(id, `has an unknown scope "${scope}"`);

  const solution = readString(value, 'solution', id);
  if (!isOptionKey(solution)) fail(id, `has an unknown solution "${solution}"`);

  const category = readString(value, 'category', id);
  if (!isCategoryId(category)) fail(id, `has an unknown category "${category}"`);

  const stateRaw = readOptionalString(value, 'state', id);
  if (scope === 'state' && stateRaw === undefined) fail(id, 'is scope:state but has no "state"');
  if (scope === 'federal' && stateRaw !== undefined) fail(id, 'is scope:federal but carries a "state"');
  if (stateRaw !== undefined && !isStateCode(stateRaw)) fail(id, `has an unknown state "${stateRaw}"`);
  const state: StateCode | undefined = stateRaw !== undefined && isStateCode(stateRaw) ? stateRaw : undefined;

  const image = readOptionalString(value, 'image', id);

  return {
    id,
    number,
    scope,
    question: readString(value, 'question', id),
    options: readOptions(value, id),
    solution,
    category,
    explanation: readString(value, 'explanation', id),
    sourceId: readString(value, 'sourceId', id),
    ...(state !== undefined ? { state } : {}),
    ...(image !== undefined ? { image } : {}),
  };
}

function parseAll(raw: readonly unknown[]): readonly Question[] {
  const parsed = raw.map(parseQuestion);
  const seen = new Set<QuestionId>();
  for (const q of parsed) {
    if (seen.has(q.id)) fail(q.id, 'is a duplicate id');
    seen.add(q.id);
  }
  return parsed;
}

/* ───────────────────────────── indexes ───────────────────────────── */

const RAW: readonly unknown[] = rawQuestions;

const ALL: readonly Question[] = parseAll(RAW);

const BY_ID: ReadonlyMap<QuestionId, Question> = new Map(ALL.map((q) => [q.id, q]));

const FEDERAL: readonly Question[] = ALL.filter((q) => q.scope === 'federal');

const EMPTY: readonly Question[] = [];

const BY_STATE: ReadonlyMap<StateCode, readonly Question[]> = (() => {
  const index = new Map<StateCode, Question[]>(STATE_CODES.map((code) => [code, []]));
  for (const q of ALL) {
    if (q.state === undefined) continue;
    const bucket = index.get(q.state);
    if (bucket === undefined) fail(q.id, `references state "${q.state}" which is not in STATE_CODES`);
    bucket.push(q);
  }
  return index;
})();

/**
 * Memoised per state. `activeDeck` is called on every dashboard render, so the
 * 310-element array is built once per state and then shared.
 */
const DECK_CACHE = new Map<StateCode, readonly Question[]>();

/* ───────────────────────────── public API ────────────────────────── */

/** All 460 shipped records. Only useful for tooling and data tests. */
export function allQuestions(): readonly Question[] {
  return ALL;
}

/** O(1) lookup. Returns `undefined` for ids that are not in the dataset. */
export function questionById(id: QuestionId): Question | undefined {
  return BY_ID.get(id);
}

/** The 300 federal questions, in dataset order (`F001`…`F300`). */
export function federalQuestions(): readonly Question[] {
  return FEDERAL;
}

/** The 10 questions belonging to one Bundesland, in dataset order. */
export function stateQuestions(state: StateCode): readonly Question[] {
  return BY_STATE.get(state) ?? EMPTY;
}

/**
 * The user's 310-question active deck: 300 federal followed by the 10 for
 * `state`. The returned array is shared and therefore `readonly` — copy it
 * (`[...activeDeck(s)]`) before sorting or shuffling.
 */
export function activeDeck(state: StateCode): readonly Question[] {
  const cached = DECK_CACHE.get(state);
  if (cached !== undefined) return cached;
  const deck: readonly Question[] = [...FEDERAL, ...stateQuestions(state)];
  DECK_CACHE.set(state, deck);
  return deck;
}

/** True when `id` exists and belongs to `state`'s active deck. */
export function isInActiveDeck(id: QuestionId, state: StateCode): boolean {
  const q = BY_ID.get(id);
  if (q === undefined) return false;
  return q.scope === 'federal' || q.state === state;
}
