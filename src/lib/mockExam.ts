// Mock exam engine: building the 33-question paper and scoring it.
//
// Pure, deterministic given its inputs, and free of React and of the store —
// exactly like `scheduler.ts` and `readiness.ts`. `MockExam.tsx` is the only
// caller that touches the DOM, timers or persistence; everything that decides
// *what the paper is* and *how it is scored* lives here so it is trivially
// unit-testable and so the review screen can recompute per-question outcomes
// without re-deriving them by hand.
//
// The 30/3 split and the 17-question pass mark are not redefined here: they
// are re-exported from `readiness.ts`, which already encodes them (that file
// is what drives the dashboard's readiness number, and it must never drift
// from what the exam itself actually draws).

import { federalQuestions, stateQuestions } from './deck';
import { FEDERAL_WEIGHT, OUT_OF, PASS_MARK, STATE_WEIGHT } from './readiness';
import { seededRng } from './scheduler';
import type { AnswerRecord, MockResult, OptionKey, Question, QuestionId, StateCode } from '@/types';

/** Federal questions drawn per paper (30). */
export const MOCK_FEDERAL_COUNT = FEDERAL_WEIGHT;
/** State questions drawn per paper (3). */
export const MOCK_STATE_COUNT = STATE_WEIGHT;
/** Total questions per paper (33). */
export const MOCK_TOTAL_QUESTIONS = OUT_OF;
/** Correct answers required to pass (17). */
export const MOCK_PASS_MARK = PASS_MARK;
/** Real exam time budget: 60 minutes. */
export const MOCK_DURATION_MS = 60 * 60_000;

/** Fisher-Yates on a copy — `federalQuestions()`/`stateQuestions()` return `readonly` arrays. */
function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = arr[i];
    const b = arr[j];
    if (a === undefined || b === undefined) continue;
    arr[i] = b;
    arr[j] = a;
  }
  return arr;
}

/**
 * Draws a 33-question paper for `state`: 30 of the 300 federal questions plus
 * 3 of that state's 10, then shuffles the two groups together — the real exam
 * does not group federal and state questions on the page.
 *
 * Deterministic in `seed`: the same `(state, seed)` pair always yields the
 * same 33 ids in the same order, which is what lets a user "retake the same
 * paper" and lets this module be tested without a real RNG. A different seed
 * is not guaranteed to differ (the pool is finite), but in practice always
 * will for these pool sizes.
 */
export function buildMockPaper(state: StateCode, seed: number): readonly Question[] {
  const rng = seededRng(seed);
  const federal = shuffled(federalQuestions(), rng).slice(0, MOCK_FEDERAL_COUNT);
  const fromState = shuffled(stateQuestions(state), rng).slice(0, MOCK_STATE_COUNT);
  return shuffled([...federal, ...fromState], rng);
}

/** One question's response as captured live during the exam. */
export interface MockResponse {
  readonly chosen: OptionKey | null;
  /** Epoch ms this response was last changed. Absent if the question was never touched. */
  readonly answeredAt?: number;
}

export type MockResponses = Readonly<Record<QuestionId, MockResponse | undefined>>;

export interface MockScore {
  readonly correct: number;
  readonly total: number;
  readonly passed: boolean;
  readonly answers: readonly AnswerRecord[];
}

/**
 * Scores a completed (or abandoned — unanswered questions just score wrong)
 * paper against the responses collected for it.
 *
 * `AnswerRecord.ms` records how far into the exam (elapsed ms since
 * `startedAt`) the user last touched a question, not a per-question dwell
 * time: free navigation during a mock (skip ahead, come back, change an
 * answer) makes true per-question dwell time ambiguous, whereas "how far in
 * was this settled" is well-defined and still useful for reconstructing
 * pacing in review. Untouched questions score `ms: 0`. Mock questions never
 * award or consume hints, so `hintsUsed` is always 0.
 */
export function scoreMockPaper(
  paper: readonly Question[],
  responses: MockResponses,
  startedAt: number,
): MockScore {
  const answers: AnswerRecord[] = paper.map((q) => {
    const response = responses[q.id];
    const chosen = response?.chosen ?? null;
    const correct = chosen !== null && chosen === q.solution;
    const ms = response?.answeredAt !== undefined ? Math.max(0, response.answeredAt - startedAt) : 0;
    return { questionId: q.id, chosen, correct, hintsUsed: 0, ms };
  });
  const correct = answers.reduce((total, a) => total + (a.correct ? 1 : 0), 0);
  return { correct, total: paper.length, passed: correct >= MOCK_PASS_MARK, answers };
}

export interface BuildMockResultInput {
  readonly id: string;
  readonly state: StateCode;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly paper: readonly Question[];
  readonly responses: MockResponses;
}

/**
 * Scores the paper and wraps the result in the frozen `MockResult` contract.
 *
 * `MockResult` has no dedicated `seed` field (it is a shared contract this
 * workstream does not own), so the paper's seed is never persisted as its own
 * value. Instead, `MockExam.tsx` uses `startedAt` itself as the seed when it
 * calls `buildMockPaper` — a value the contract already stores — so the exact
 * same 33-question paper can always be reconstructed later from a persisted
 * `MockResult` alone, satisfying "store the seed" without adding a field to a
 * type this workstream must not edit.
 */
export function buildMockResult(input: BuildMockResultInput): MockResult {
  const score = scoreMockPaper(input.paper, input.responses, input.startedAt);
  return {
    id: input.id,
    state: input.state,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: Math.max(0, input.finishedAt - input.startedAt),
    answers: score.answers,
    correct: score.correct,
    total: score.total,
    passed: score.passed,
  };
}
