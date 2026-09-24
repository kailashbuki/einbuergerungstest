// Readiness: the one number on the dashboard.
//
// The real Einbürgerungstest is 33 questions — 30 federal plus 3 drawn from the
// user's Bundesland — and 17 correct is a pass. So readiness is expressed in the
// same unit the user will be graded in: "you'd score about 24 / 33".
//
// The weighting matters and is the easiest thing to get wrong: the 10 state
// questions are worth 3 points, not 10/310 of the score. Mastering all of them
// can move the number by at most 3.

import { activeDeck, federalQuestions, stateQuestions } from './deck';
import { masteryOf } from './mastery';
import type { ProgressMap } from './progressModel';
import type { MasteryBucket, Question, QuestionProgress, StateCode } from '@/types';

/** Exam shape. */
export const OUT_OF = 33;
export const PASS_MARK = 17;
/** 30 of the 33 exam questions come from the federal pool. */
export const FEDERAL_WEIGHT = 30;
/** 3 come from the user's Bundesland. */
export const STATE_WEIGHT = 3;

/** A typical exam session is ten questions. */
export const SESSION_SIZE = 10;
/** Mastery needs two clean correct answers, so a question needs ~2 exposures. */
export const REPS_PER_MASTERY = 2;

/** Score at or above which we stop nagging and drop the "sessions to go" estimate. */
export const READY_SCORE = 21;
/** Comfortably above the pass mark — exam variance is roughly ±3 questions. */
export const SOLID_SCORE = 28;

export type ReadinessBand = 'notReady' | 'borderline' | 'ready' | 'solid';

/**
 * Expected P(correct) per bucket.
 *
 * - `new` 0.25 — four options, blind guess. This is the floor of the hero number
 *   and why a fresh account reads 8.25 / 33 rather than 0.
 * - `learning` 0.45 — seen it, got the last one wrong: better than a guess
 *   because distractors start to look wrong, but still a coin flip at best.
 * - `familiar` 0.75 — last answer correct, but either only once or with a hint.
 * - `mastered` 0.97 — two clean repetitions; we still hold back 3% for exam
 *   nerves and trick wording.
 */
export const BUCKET_PROBABILITY: Readonly<Record<MasteryBucket, number>> = {
  new: 0.25,
  learning: 0.45,
  familiar: 0.75,
  mastered: 0.97,
};

/** The bucket prior is worth this many observations, so one answer can't swing the estimate. */
export const HISTORY_PSEUDO_COUNT = 2;
/** Half bucket prior, half smoothed observed accuracy. */
export const HISTORY_WEIGHT = 0.5;
/** A question the user is confidently wrong about can go below a blind guess. */
export const MIN_PROBABILITY = 0.1;
/** Never claim certainty. */
export const MAX_PROBABILITY = 0.99;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * P(correct) for one question. Starts from the mastery bucket, then pulls toward
 * the observed accuracy where there is history — a question answered 3/10 is
 * weaker than its bucket suggests, and one answered 8/8 is stronger.
 *
 * Monotonic in the bucket for any fixed history, which keeps the hero number
 * from ever going *down* when a user's mastery goes up.
 */
export function questionProbability(progress: QuestionProgress | undefined): number {
  if (progress === undefined || progress.seen === 0) return BUCKET_PROBABILITY.new;
  const base = BUCKET_PROBABILITY[masteryOf(progress)];
  const smoothed =
    (progress.correct + HISTORY_PSEUDO_COUNT * base) / (progress.seen + HISTORY_PSEUDO_COUNT);
  const blended = (1 - HISTORY_WEIGHT) * base + HISTORY_WEIGHT * smoothed;
  return clamp(blended, MIN_PROBABILITY, MAX_PROBABILITY);
}

/** P(correct) for a question that has just been mastered — the ceiling a drill can realistically reach. */
const MASTERED_TARGET_PROBABILITY = questionProbability({
  seen: REPS_PER_MASTERY,
  correct: REPS_PER_MASTERY,
  wrong: 0,
  consecutiveCorrect: REPS_PER_MASTERY,
  hintsUsed: 0,
  lastSeen: 1,
  ease: 2.5,
  dueAt: 2,
  flagged: false,
  note: '',
  updatedAt: 1,
});

function meanProbability(questions: readonly Question[], progress: ProgressMap): number {
  if (questions.length === 0) return 0;
  let total = 0;
  for (const q of questions) total += questionProbability(progress[q.id]);
  return total / questions.length;
}

export function bandFor(score: number): ReadinessBand {
  if (score < PASS_MARK) return 'notReady';
  if (score < READY_SCORE) return 'borderline';
  if (score < SOLID_SCORE) return 'ready';
  return 'solid';
}

export interface Readiness {
  /** Predicted raw score, 0–33, rounded to 2dp so the "8.25 at zero progress" invariant is exact. */
  readonly score: number;
  readonly outOf: number;
  readonly passMark: number;
  readonly band: ReadinessBand;
  /** 0–30. */
  readonly federalComponent: number;
  /** 0–3. */
  readonly stateComponent: number;
  /** 0–1. Reaches 1 when every active-deck question has been answered at least twice. */
  readonly confidence: number;
}

/**
 * How much to trust the score: the share of possible "first two answers" the
 * user has actually given across the active deck. Two observations per question
 * is where the per-question estimate stops being mostly prior.
 */
function confidenceOf(deck: readonly Question[], progress: ProgressMap): number {
  if (deck.length === 0) return 0;
  let observed = 0;
  for (const q of deck) {
    const p = progress[q.id];
    if (p === undefined) continue;
    observed += Math.min(REPS_PER_MASTERY, Math.max(0, p.seen));
  }
  return clamp(observed / (deck.length * REPS_PER_MASTERY), 0, 1);
}

/**
 * Predicted score out of 33 for the *active* state only. Federal progress is
 * shared across states (ids are global), so switching Bundesland changes only
 * the 3-point state component.
 */
export function readinessScore(state: StateCode, progress: ProgressMap): Readiness {
  const federalComponent = meanProbability(federalQuestions(), progress) * FEDERAL_WEIGHT;
  const stateComponent = meanProbability(stateQuestions(state), progress) * STATE_WEIGHT;
  const score = clamp(round2(federalComponent + stateComponent), 0, OUT_OF);
  return {
    score,
    outOf: OUT_OF,
    passMark: PASS_MARK,
    band: bandFor(score),
    federalComponent: round2(federalComponent),
    stateComponent: round2(stateComponent),
    confidence: round2(confidenceOf(activeDeck(state), progress)),
  };
}

/**
 * Rough number of ~10-question sessions still needed to reach `READY_SCORE`.
 *
 * Model: repeatedly "master" the question with the best points-per-question
 * payoff until the target is reached, then assume each question needs
 * `REPS_PER_MASTERY` exposures and each session holds `SESSION_SIZE` of them.
 * State questions are worth 0.3 points each against 0.1 for a federal one, so
 * the estimate naturally spends its first session on the Heimat questions.
 *
 * `null` when the user is already at or above `READY_SCORE`, or when there is
 * nothing left that could raise the score.
 */
export function estimatedSessionsToReady(state: StateCode, progress: ProgressMap): number | null {
  const federal = federalQuestions();
  const stateQs = stateQuestions(state);
  if (federal.length === 0 || stateQs.length === 0) return null;

  const current = readinessScore(state, progress).score;
  if (current >= READY_SCORE) return null;

  const federalPerQuestion = FEDERAL_WEIGHT / federal.length;
  const statePerQuestion = STATE_WEIGHT / stateQs.length;

  const gains: number[] = [];
  for (const q of federal) {
    const gain = (MASTERED_TARGET_PROBABILITY - questionProbability(progress[q.id])) * federalPerQuestion;
    if (gain > 0) gains.push(gain);
  }
  for (const q of stateQs) {
    const gain = (MASTERED_TARGET_PROBABILITY - questionProbability(progress[q.id])) * statePerQuestion;
    if (gain > 0) gains.push(gain);
  }
  if (gains.length === 0) return null;

  gains.sort((a, b) => b - a);
  let needed = READY_SCORE - current;
  let questions = 0;
  for (const gain of gains) {
    if (needed <= 0) break;
    needed -= gain;
    questions += 1;
  }
  if (needed > 0) return null;

  return Math.max(1, Math.ceil((questions * REPS_PER_MASTERY) / SESSION_SIZE));
}
