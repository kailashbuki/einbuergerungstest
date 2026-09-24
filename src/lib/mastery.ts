// Mastery buckets, level stars and per-category strength.
//
// These are the *display* semantics of progress: the heatmap colour, the 1–3
// stars on a level tile, the category bars on the dashboard. Thresholds are
// intentionally crisp and few, so that a user can learn the rule ("get it right
// twice in a row without a hint") in one sentence.

import { CATEGORY_IDS, type CategoryId } from '@/data/categories';
import type { AnswerRecord, MasteryBucket, Question, QuestionId, QuestionProgress } from '@/types';
import type { ProgressMap } from './progressModel';

/** Two clean repetitions is the bar for ★★★ / "mastered". Enough to be real, low enough to be reachable for 310 questions. */
export const MASTERY_STREAK = 2;
/** One correct answer means "I have this, probably" — the amber-to-green step. */
export const FAMILIAR_STREAK = 1;
/** The official exam needs 17/33 ≈ 52%, but a level only counts as cleared at 70% — practice bar above the real bar. */
export const CLEAR_THRESHOLD = 0.7;

export const MASTERY_BUCKETS: readonly MasteryBucket[] = ['new', 'learning', 'familiar', 'mastered'];

/**
 * Bucket for one question:
 *
 * - `new`      — never answered (undefined progress, or `seen === 0`).
 * - `mastered` — `consecutiveCorrect >= 2` **and** `hintsUsed === 0`.
 * - `familiar` — `consecutiveCorrect >= 1` (includes hinted-but-correct).
 * - `learning` — seen, but the last answer was wrong.
 *
 * The hint rule is the one users notice: answering twice correctly *with* a hint
 * leaves you at `familiar` forever. Hints buy a correct answer, not mastery.
 */
export function masteryOf(progress: QuestionProgress | undefined): MasteryBucket {
  if (progress === undefined || progress.seen === 0) return 'new';
  if (progress.consecutiveCorrect >= MASTERY_STREAK && progress.hintsUsed === 0) return 'mastered';
  if (progress.consecutiveCorrect >= FAMILIAR_STREAK) return 'familiar';
  return 'learning';
}

export type MasteryCounts = Readonly<Record<MasteryBucket, number>>;

/** Bucket histogram over a deck (pass the 310-question active deck, not all 460). */
export function masteryCounts(deck: readonly Question[], progress: ProgressMap): MasteryCounts {
  let bNew = 0;
  let learning = 0;
  let familiar = 0;
  let mastered = 0;
  for (const q of deck) {
    switch (masteryOf(progress[q.id])) {
      case 'new':
        bNew += 1;
        break;
      case 'learning':
        learning += 1;
        break;
      case 'familiar':
        familiar += 1;
        break;
      case 'mastered':
        mastered += 1;
        break;
    }
  }
  return { new: bNew, learning, familiar, mastered };
}

/**
 * "Currently correct": the most recent answer was correct. `consecutiveCorrect`
 * already encodes exactly that, since a wrong answer resets it to 0.
 */
function isCurrentlyCorrect(progress: QuestionProgress | undefined): boolean {
  return progress !== undefined && progress.consecutiveCorrect >= FAMILIAR_STREAK;
}

function clearedRatio(questionIds: readonly QuestionId[], progress: ProgressMap): number {
  if (questionIds.length === 0) return 0;
  let correct = 0;
  for (const id of questionIds) {
    if (isCurrentlyCorrect(progress[id])) correct += 1;
  }
  return correct / questionIds.length;
}

/** 0–100, the share of the level's questions whose last answer was correct. */
export function levelProgressPercent(questionIds: readonly QuestionId[], progress: ProgressMap): number {
  return Math.round(clearedRatio(questionIds, progress) * 100);
}

/**
 * ★ condition. Compared on the raw ratio, not the rounded percent, so 69.5%
 * does not sneak through as 70%.
 *
 * A supplied pass record can also clear the level on its own: scoring ≥70% in
 * one run counts even if the user has since got some of those questions wrong.
 */
export function isLevelCleared(
  questionIds: readonly QuestionId[],
  progress: ProgressMap,
  lastPassAnswers?: readonly AnswerRecord[],
): boolean {
  if (questionIds.length === 0) return false;
  if (clearedRatio(questionIds, progress) >= CLEAR_THRESHOLD) return true;
  const pass = passStats(questionIds, lastPassAnswers);
  return pass !== null && pass.ratio >= CLEAR_THRESHOLD;
}

interface PassStats {
  readonly ratio: number;
  /** True when the pass covered every question in the level and got all of them right. */
  readonly perfect: boolean;
}

/**
 * What "one pass" means: a single `SessionResult`-shaped list of answers. Only
 * answers for questions in this level are considered; a question answered more
 * than once in that pass must have been correct *every* time, so a
 * wrong-then-retry inside the same run does not count as a clean pass.
 */
function passStats(
  questionIds: readonly QuestionId[],
  lastPassAnswers: readonly AnswerRecord[] | undefined,
): PassStats | null {
  if (lastPassAnswers === undefined || questionIds.length === 0) return null;
  const inLevel = new Set<QuestionId>(questionIds);
  const allCorrect = new Map<QuestionId, boolean>();
  for (const answer of lastPassAnswers) {
    if (!inLevel.has(answer.questionId)) continue;
    const previous = allCorrect.get(answer.questionId);
    allCorrect.set(answer.questionId, (previous ?? true) && answer.correct);
  }
  if (allCorrect.size === 0) return null;
  let correct = 0;
  for (const ok of allCorrect.values()) {
    if (ok) correct += 1;
  }
  const covered = allCorrect.size === inLevel.size;
  return { ratio: correct / questionIds.length, perfect: covered && correct === inLevel.size };
}

/** Every question in the level is `mastered` (2 in a row, zero hints ever). */
function isLevelMastered(questionIds: readonly QuestionId[], progress: ProgressMap): boolean {
  if (questionIds.length === 0) return false;
  return questionIds.every((id) => masteryOf(progress[id]) === 'mastered');
}

/**
 * Stars for a level:
 *
 * - ★   cleared: ≥70% of the level's questions currently correct (or a supplied
 *       pass scored ≥70%).
 * - ★★  a clean pass: one supplied pass covered every question in the level and
 *       every one of them was correct. Because it is evaluated against a pass
 *       record rather than live progress, replaying a level later can still earn
 *       it — and a later mistake cannot take it away.
 * - ★★★ mastered: every question has ≥2 consecutive correct answers and zero
 *       hints used. This is strictly stronger evidence than a clean pass, so it
 *       is awarded even when no pass record is supplied (the caller may not have
 *       kept one — e.g. the level was learned through Drill).
 *
 * An empty level scores 0.
 */
export function levelStars(
  questionIds: readonly QuestionId[],
  progress: ProgressMap,
  lastPassAnswers?: readonly AnswerRecord[],
): 0 | 1 | 2 | 3 {
  if (questionIds.length === 0) return 0;
  if (isLevelMastered(questionIds, progress)) return 3;
  const pass = passStats(questionIds, lastPassAnswers);
  if (pass !== null && pass.perfect) return 2;
  if (isLevelCleared(questionIds, progress, lastPassAnswers)) return 1;
  return 0;
}

/* ─────────────────────────── category strength ───────────────────── */

/**
 * Strength weight per bucket. `familiar` sits at 0.65 rather than 0.5 so a
 * category the user has answered correctly once reads as clearly-better-than-
 * half, matching how the bars feel next to the readiness number.
 */
export const STRENGTH_WEIGHTS: Readonly<Record<MasteryBucket, number>> = {
  new: 0,
  learning: 0.2,
  familiar: 0.65,
  mastered: 1,
};

export interface CategoryStrength {
  readonly category: CategoryId;
  /** 0–1, mean bucket weight over the category's questions in this deck. */
  readonly strength: number;
  readonly total: number;
  readonly counts: MasteryCounts;
}

/**
 * Per-category strength for the dashboard bars and the "Drill this" button,
 * **weakest first**. Categories with no questions in the deck are omitted.
 * Ties break on size (bigger categories first — more exam impact) then id, so
 * the ordering is deterministic.
 */
export function categoryStrength(
  deck: readonly Question[],
  progress: ProgressMap,
): readonly CategoryStrength[] {
  const byCategory = new Map<CategoryId, Question[]>();
  for (const q of deck) {
    const bucket = byCategory.get(q.category);
    if (bucket === undefined) byCategory.set(q.category, [q]);
    else bucket.push(q);
  }

  const rows: CategoryStrength[] = [];
  for (const category of CATEGORY_IDS) {
    const questions = byCategory.get(category);
    if (questions === undefined || questions.length === 0) continue;
    const counts = masteryCounts(questions, progress);
    const weighted =
      counts.new * STRENGTH_WEIGHTS.new +
      counts.learning * STRENGTH_WEIGHTS.learning +
      counts.familiar * STRENGTH_WEIGHTS.familiar +
      counts.mastered * STRENGTH_WEIGHTS.mastered;
    rows.push({ category, strength: weighted / questions.length, total: questions.length, counts });
  }

  rows.sort((a, b) => {
    if (a.strength !== b.strength) return a.strength - b.strength;
    if (a.total !== b.total) return b.total - a.total;
    return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
  });
  return rows;
}
