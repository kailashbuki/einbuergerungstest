// SM-2-lite spaced repetition + the "practice what I get wrong" queues.
//
// Deliberately simpler than real SM-2: there is no 0–5 self-grade, only
// correct/incorrect, because the app never asks the user to rate themselves.
// Everything here is pure — `now` is always a parameter, and the only source of
// randomness is an optional injected rng, so drill ordering is reproducible in
// tests and stable across re-renders.

import type { Question, QuestionId, QuestionProgress } from '@/types';
import type { ProgressMap } from './progressModel';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** SM-2's classic starting ease. Kept so the first graduation is ~2.5×. */
export const DEFAULT_EASE = 2.5;
/** Floor: below ~1.3 the interval barely grows and the card churns forever. */
export const MIN_EASE = 1.3;
/** Cap: above ~2.8 intervals explode past the few weeks a test candidate has. */
export const MAX_EASE = 2.8;
/** Small upward nudge on a correct answer — slow, so one lucky guess barely moves it. */
export const EASE_BONUS = 0.05;
/** Four times the bonus: forgetting is much stronger evidence than remembering. */
export const EASE_PENALTY = 0.2;

/**
 * Explicit ladder for the first repetitions. The 10-minute first step is the
 * important one: a question learned at the start of a study session comes back
 * within the same session-day instead of vanishing for a day.
 */
export const LEARNING_STEPS_MS: readonly number[] = [10 * MINUTE_MS, 1 * DAY_MS, 3 * DAY_MS];

/** Candidates study for weeks, not years — never park a question beyond this. */
export const MAX_INTERVAL_MS = 180 * DAY_MS;

/** A question is a "nemesis" once it has been missed this many times. */
export const NEMESIS_WRONG_THRESHOLD = 3;

/** Default drill/session length used across the app. */
export const DEFAULT_DRILL_SIZE = 10;

export interface ScheduleOutcome {
  readonly ease: number;
  readonly dueAt: number;
}

function clampEase(ease: number): number {
  if (!Number.isFinite(ease)) return DEFAULT_EASE;
  return Math.min(MAX_EASE, Math.max(MIN_EASE, ease));
}

function lastStep(): number {
  // LEARNING_STEPS_MS is a non-empty constant, but `noUncheckedIndexedAccess`
  // makes that invisible to the type system, so fall back honestly.
  return LEARNING_STEPS_MS[LEARNING_STEPS_MS.length - 1] ?? DAY_MS;
}

function firstStep(): number {
  return LEARNING_STEPS_MS[0] ?? 10 * MINUTE_MS;
}

/** The interval the previous review handed out, recovered from `dueAt - lastSeen`. */
function previousIntervalMs(prev: QuestionProgress): number {
  const derived = prev.dueAt - prev.lastSeen;
  return derived > 0 ? derived : lastStep();
}

/** The ease this answer leaves behind. Correct nudges up, wrong drops hard. */
export function nextEase(prev: QuestionProgress, correct: boolean): number {
  const base = clampEase(prev.ease);
  return clampEase(correct ? base + EASE_BONUS : base - EASE_PENALTY);
}

/**
 * Interval in ms until the question should be shown again.
 *
 * - Wrong → straight back to the shortest step (10 min), no matter how well the
 *   question was known before. Lapses must be re-learned the same day.
 * - Correct while still on the ladder → the next ladder step, indexed by the
 *   streak *before* this answer.
 * - Correct past the ladder → previous interval × the new ease, capped.
 */
export function nextInterval(prev: QuestionProgress, correct: boolean): number {
  if (!correct) return firstStep();
  const streak = Math.max(0, Math.trunc(prev.consecutiveCorrect));
  const step = LEARNING_STEPS_MS[streak];
  if (step !== undefined) return step;
  const grown = Math.round(previousIntervalMs(prev) * nextEase(prev, correct));
  return Math.min(MAX_INTERVAL_MS, Math.max(lastStep(), grown));
}

/** The `{ ease, dueAt }` pair `recordAnswer` writes back onto the progress row. */
export function schedule(prev: QuestionProgress, correct: boolean, now: number): ScheduleOutcome {
  return { ease: nextEase(prev, correct), dueAt: now + nextInterval(prev, correct) };
}

/** Never-seen questions are always due; seen ones once `dueAt` has passed. */
export function isDue(progress: QuestionProgress | undefined, now: number): boolean {
  if (progress === undefined || progress.seen === 0) return true;
  return progress.dueAt <= now;
}

/** Everything due right now, in deck order. */
export function dueQuestions(
  deck: readonly Question[],
  progress: ProgressMap,
  now: number,
): readonly Question[] {
  return deck.filter((q) => isDue(progress[q.id], now));
}

/* ───────────────────────────── drill ranking ─────────────────────── */

interface Rank {
  /** How long past due, ms. Never-seen questions score 0 here (see `neverSeen`). */
  readonly overdueMs: number;
  readonly wrong: number;
  readonly consecutiveCorrect: number;
  /** 1 for never-seen, so they outrank equally-weak seen questions. */
  readonly neverSeen: 0 | 1;
  readonly lastSeen: number;
  readonly id: QuestionId;
}

function rankOf(q: Question, progress: ProgressMap, now: number): Rank {
  const p = progress[q.id];
  if (p === undefined || p.seen === 0) {
    return { overdueMs: 0, wrong: 0, consecutiveCorrect: 0, neverSeen: 1, lastSeen: 0, id: q.id };
  }
  return {
    overdueMs: Math.max(0, now - p.dueAt),
    wrong: p.wrong,
    consecutiveCorrect: p.consecutiveCorrect,
    neverSeen: 0,
    lastSeen: p.lastSeen,
    id: q.id,
  };
}

/**
 * Weakest first. Order of criteria is fixed by the product plan:
 * overdue-ness → wrong count → low streak → never-seen → oldest first.
 * `id` is the final tiebreak so the result is a total order and therefore
 * byte-identical across repeated calls.
 */
function compareRank(a: Rank, b: Rank): number {
  if (a.overdueMs !== b.overdueMs) return b.overdueMs - a.overdueMs;
  if (a.wrong !== b.wrong) return b.wrong - a.wrong;
  if (a.consecutiveCorrect !== b.consecutiveCorrect) return a.consecutiveCorrect - b.consecutiveCorrect;
  if (a.neverSeen !== b.neverSeen) return b.neverSeen - a.neverSeen;
  if (a.lastSeen !== b.lastSeen) return a.lastSeen - b.lastSeen;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** True when two ranks differ only by `id`, i.e. they are equally weak. */
function sameStrength(a: Rank, b: Rank): boolean {
  return (
    a.overdueMs === b.overdueMs &&
    a.wrong === b.wrong &&
    a.consecutiveCorrect === b.consecutiveCorrect &&
    a.neverSeen === b.neverSeen &&
    a.lastSeen === b.lastSeen
  );
}

/**
 * mulberry32. A tiny seeded PRNG so callers that *want* variety between drills
 * (e.g. "shuffle my 300 untouched questions") can get it reproducibly. Never
 * used by default — `Math.random()` in the engine makes tests flaky.
 */
export function seededRng(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(items: T[], from: number, to: number, rng: () => number): void {
  for (let i = to - 1; i > from; i -= 1) {
    const j = from + Math.floor(rng() * (i - from + 1));
    const a = items[i];
    const b = items[j];
    if (a === undefined || b === undefined) continue;
    items[i] = b;
    items[j] = a;
  }
}

/**
 * The Drill queue: up to `size` questions, weakest first, no repeats.
 *
 * Deterministic by default. Pass `rng` to shuffle *within* groups of equally
 * weak questions — this keeps "weakest first" intact while stopping a fresh
 * account from always drilling F001…F010.
 */
export function buildDrill(
  deck: readonly Question[],
  progress: ProgressMap,
  now: number,
  size: number = DEFAULT_DRILL_SIZE,
  rng?: () => number,
): readonly Question[] {
  if (size <= 0) return [];

  const unique: Question[] = [];
  const seenIds = new Set<QuestionId>();
  for (const q of deck) {
    if (seenIds.has(q.id)) continue;
    seenIds.add(q.id);
    unique.push(q);
  }

  const ranks = new Map<QuestionId, Rank>(unique.map((q) => [q.id, rankOf(q, progress, now)]));
  const fallback: Rank = { overdueMs: 0, wrong: 0, consecutiveCorrect: 0, neverSeen: 1, lastSeen: 0, id: '' };
  const rankFor = (q: Question): Rank => ranks.get(q.id) ?? fallback;

  const ordered = [...unique].sort((a, b) => compareRank(rankFor(a), rankFor(b)));

  if (rng !== undefined) {
    let start = 0;
    for (let i = 1; i <= ordered.length; i += 1) {
      const head = ordered[start];
      const current = i < ordered.length ? ordered[i] : undefined;
      const stillEqual =
        head !== undefined && current !== undefined && sameStrength(rankFor(head), rankFor(current));
      if (!stillEqual) {
        if (i - start > 1) shuffleInPlace(ordered, start, i, rng);
        start = i;
      }
    }
  }

  return ordered.slice(0, Math.trunc(size));
}

/**
 * The Nemesis queue: only questions missed at least `NEMESIS_WRONG_THRESHOLD`
 * times, worst first. Empty is a valid (and celebrated) result.
 */
export function buildNemesis(
  deck: readonly Question[],
  progress: ProgressMap,
  size: number = DEFAULT_DRILL_SIZE,
): readonly Question[] {
  if (size <= 0) return [];

  const seenIds = new Set<QuestionId>();
  const candidates: { readonly q: Question; readonly p: QuestionProgress }[] = [];
  for (const q of deck) {
    if (seenIds.has(q.id)) continue;
    seenIds.add(q.id);
    const p = progress[q.id];
    if (p === undefined || p.wrong < NEMESIS_WRONG_THRESHOLD) continue;
    candidates.push({ q, p });
  }

  candidates.sort((a, b) => {
    if (a.p.wrong !== b.p.wrong) return b.p.wrong - a.p.wrong;
    const accA = a.p.seen > 0 ? a.p.correct / a.p.seen : 0;
    const accB = b.p.seen > 0 ? b.p.correct / b.p.seen : 0;
    if (accA !== accB) return accA - accB;
    if (a.p.consecutiveCorrect !== b.p.consecutiveCorrect) {
      return a.p.consecutiveCorrect - b.p.consecutiveCorrect;
    }
    return a.q.id < b.q.id ? -1 : a.q.id > b.q.id ? 1 : 0;
  });

  return candidates.slice(0, Math.trunc(size)).map((c) => c.q);
}
