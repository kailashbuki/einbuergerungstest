import { describe, expect, it } from 'vitest';
import type { AnswerRecord, QuestionProgress } from '@/types';
import { masteryOf } from './mastery';
import {
  accuracy,
  applyAnswerRecord,
  emptyProgress,
  recordAnswer,
  setFlag,
  setNote,
} from './progressModel';
import { DEFAULT_EASE, MINUTE_MS } from './scheduler';

/** Fixed clock: 2026-05-04T07:30:00Z. */
const T0 = Date.UTC(2026, 4, 4, 7, 30, 0);

function correctAt(prev: QuestionProgress | undefined, now: number, hintsUsed = 0): QuestionProgress {
  return recordAnswer(prev, { correct: true, hintsUsed, now });
}

function wrongAt(prev: QuestionProgress | undefined, now: number, hintsUsed = 0): QuestionProgress {
  return recordAnswer(prev, { correct: false, hintsUsed, now });
}

describe('emptyProgress', () => {
  it('is fully zeroed with the SM-2-lite default ease', () => {
    expect(emptyProgress(T0)).toEqual({
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
      updatedAt: T0,
    });
    expect(DEFAULT_EASE).toBe(2.5);
  });

  it('is due immediately and counts as new', () => {
    expect(emptyProgress(T0).dueAt).toBe(0);
    expect(masteryOf(emptyProgress(T0))).toBe('new');
  });
});

describe('recordAnswer', () => {
  it('counts a correct answer and schedules a review', () => {
    const p = correctAt(emptyProgress(T0), T0);
    expect(p.seen).toBe(1);
    expect(p.correct).toBe(1);
    expect(p.wrong).toBe(0);
    expect(p.consecutiveCorrect).toBe(1);
    expect(p.lastSeen).toBe(T0);
    expect(p.updatedAt).toBe(T0);
    expect(p.dueAt).toBe(T0 + 10 * MINUTE_MS);
  });

  it('counts a wrong answer', () => {
    const p = wrongAt(emptyProgress(T0), T0);
    expect(p.seen).toBe(1);
    expect(p.correct).toBe(0);
    expect(p.wrong).toBe(1);
    expect(p.consecutiveCorrect).toBe(0);
  });

  it('resets the streak to 0 on a wrong answer and rebuilds it afterwards', () => {
    let p = correctAt(emptyProgress(T0), T0);
    p = correctAt(p, T0 + 1000);
    p = correctAt(p, T0 + 2000);
    expect(p.consecutiveCorrect).toBe(3);

    p = wrongAt(p, T0 + 3000);
    expect(p.consecutiveCorrect).toBe(0);
    expect(p.seen).toBe(4);
    expect(p.correct).toBe(3);
    expect(p.wrong).toBe(1);

    p = correctAt(p, T0 + 4000);
    expect(p.consecutiveCorrect).toBe(1);
  });

  it('accumulates hintsUsed and never silently zeroes it', () => {
    let p = correctAt(emptyProgress(T0), T0, 2);
    expect(p.hintsUsed).toBe(2);
    p = correctAt(p, T0 + 1000, 1);
    expect(p.hintsUsed).toBe(3);
    p = wrongAt(p, T0 + 2000, 0);
    expect(p.hintsUsed).toBe(3);
    p = correctAt(p, T0 + 3000, 0);
    p = correctAt(p, T0 + 4000, 0);
    // Two clean answers, but the hint debt stands: familiar, not mastered.
    expect(p.consecutiveCorrect).toBe(2);
    expect(p.hintsUsed).toBe(3);
    expect(masteryOf(p)).toBe('familiar');
  });

  it('sanitises a nonsensical hint count', () => {
    expect(correctAt(emptyProgress(T0), T0, -3).hintsUsed).toBe(0);
    expect(correctAt(emptyProgress(T0), T0, Number.NaN).hintsUsed).toBe(0);
    expect(correctAt(emptyProgress(T0), T0, 2.7).hintsUsed).toBe(2);
  });

  it('is pure — the input object is never mutated', () => {
    const before = emptyProgress(T0);
    const snapshot = { ...before };
    const after = correctAt(before, T0 + 5000);
    expect(before).toEqual(snapshot);
    expect(after).not.toBe(before);
  });

  it('accepts undefined as "no progress yet"', () => {
    const p = recordAnswer(undefined, { correct: true, hintsUsed: 0, now: T0 });
    expect(p.seen).toBe(1);
    expect(p.ease).toBeCloseTo(2.55, 10);
  });

  it('preserves the flag and the note', () => {
    const flagged = setNote(setFlag(emptyProgress(T0), true, T0), 'Artikel 20 GG', T0);
    const p = correctAt(flagged, T0 + 1000);
    expect(p.flagged).toBe(true);
    expect(p.note).toBe('Artikel 20 GG');
  });

  it('folds an AnswerRecord straight from a finished session', () => {
    const record: AnswerRecord = { questionId: 'F001', chosen: 'a', correct: true, hintsUsed: 1, ms: 4200 };
    const p = applyAnswerRecord(undefined, record, T0);
    expect(p.seen).toBe(1);
    expect(p.correct).toBe(1);
    expect(p.hintsUsed).toBe(1);
    expect(p.lastSeen).toBe(T0);
  });
});

describe('setFlag / setNote', () => {
  it('bumps updatedAt without touching the answer counters', () => {
    const base = correctAt(emptyProgress(T0), T0);
    const flagged = setFlag(base, true, T0 + 9999);
    expect(flagged.flagged).toBe(true);
    expect(flagged.updatedAt).toBe(T0 + 9999);
    expect(flagged.seen).toBe(base.seen);
    expect(flagged.dueAt).toBe(base.dueAt);
    expect(base.flagged).toBe(false);

    const unflagged = setFlag(flagged, false, T0 + 10_000);
    expect(unflagged.flagged).toBe(false);
    expect(unflagged.updatedAt).toBe(T0 + 10_000);
  });

  it('stores and clears a note', () => {
    const noted = setNote(undefined, 'Merksatz', T0);
    expect(noted.note).toBe('Merksatz');
    expect(noted.updatedAt).toBe(T0);
    expect(setNote(noted, '', T0 + 1).note).toBe('');
  });
});

describe('accuracy', () => {
  it('is null until the question has been answered', () => {
    expect(accuracy(undefined)).toBeNull();
    expect(accuracy(emptyProgress(T0))).toBeNull();
  });

  it('is correct / seen', () => {
    let p = correctAt(emptyProgress(T0), T0);
    p = wrongAt(p, T0 + 1);
    expect(accuracy(p)).toBeCloseTo(0.5, 10);
  });
});
