// The per-question progress primitive.
//
// `QuestionProgress` is the only thing that gets written when a user answers a
// question, and it is deeply `readonly`, so every function here returns a brand
// new object. No clock access: `now` is always passed in, which is what makes
// both the tests and the sync layer's last-write-wins merge predictable.

import type { AnswerRecord, QuestionId, QuestionProgress } from '@/types';
import { DEFAULT_EASE, schedule } from './scheduler';

/** Shape of `ProgressDoc['progress']`, re-exported so the engine has one name for it. */
export type ProgressMap = Readonly<Record<QuestionId, QuestionProgress>>;

export interface AnswerInput {
  readonly correct: boolean;
  /** Hints revealed for *this* attempt. Accumulated, never reset — see `mastery.ts`. */
  readonly hintsUsed: number;
  readonly now: number;
}

function nonNegativeInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/** A zeroed row. `dueAt: 0` means "due immediately", which is what we want for new questions. */
export function emptyProgress(now: number): QuestionProgress {
  return {
    seen: 0,
    correct: 0,
    wrong: 0,
    consecutiveCorrect: 0,
    hintsUsed: 0,
    lastSeen: 0,
    ease: DEFAULT_EASE,
    dueAt: 0,
    flagged: false,
    note: '',
    updatedAt: now,
  };
}

/**
 * Fold one answer into a progress row.
 *
 * `consecutiveCorrect` is the streak that drives both the SM-2-lite ladder and
 * the mastery buckets: it increments on a correct answer and resets to 0 on a
 * wrong one. `hintsUsed` accumulates for the lifetime of the question — that is
 * deliberate, because "used a hint" must permanently block ★★★ until the user
 * re-earns it by answering cleanly... which they cannot, by design. Hints are a
 * safety net with a real cost.
 *
 * `prev` may be `undefined` so callers can fold over an answer log without
 * pre-seeding the map.
 */
export function recordAnswer(prev: QuestionProgress | undefined, input: AnswerInput): QuestionProgress {
  const base = prev ?? emptyProgress(input.now);
  const hints = nonNegativeInt(input.hintsUsed);
  const { ease, dueAt } = schedule(base, input.correct, input.now);

  return {
    seen: base.seen + 1,
    correct: base.correct + (input.correct ? 1 : 0),
    wrong: base.wrong + (input.correct ? 0 : 1),
    consecutiveCorrect: input.correct ? base.consecutiveCorrect + 1 : 0,
    hintsUsed: base.hintsUsed + hints,
    lastSeen: input.now,
    ease,
    dueAt,
    flagged: base.flagged,
    note: base.note,
    updatedAt: input.now,
  };
}

/** Convenience overload for committing a finished session's `AnswerRecord`s. */
export function applyAnswerRecord(
  prev: QuestionProgress | undefined,
  record: AnswerRecord,
  now: number,
): QuestionProgress {
  return recordAnswer(prev, { correct: record.correct, hintsUsed: record.hintsUsed, now });
}

/** Toggle the "review later" flag. Bumps `updatedAt` so the merge picks it up. */
export function setFlag(
  prev: QuestionProgress | undefined,
  flagged: boolean,
  now: number,
): QuestionProgress {
  const base = prev ?? emptyProgress(now);
  return { ...base, flagged, updatedAt: now };
}

/** Replace the user's private note. Bumps `updatedAt` so the merge picks it up. */
export function setNote(
  prev: QuestionProgress | undefined,
  note: string,
  now: number,
): QuestionProgress {
  const base = prev ?? emptyProgress(now);
  return { ...base, note, updatedAt: now };
}

/** Observed accuracy, or `null` when the question has never been answered. */
export function accuracy(progress: QuestionProgress | undefined): number | null {
  if (progress === undefined || progress.seen === 0) return null;
  return progress.correct / progress.seen;
}
