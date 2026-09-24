import { describe, expect, it } from 'vitest';
import { STATE_CODES } from '@/data/states';
import type { QuestionId, QuestionProgress } from '@/types';
import { activeDeck, federalQuestions, stateQuestions } from './deck';
import { emptyProgress, type ProgressMap } from './progressModel';
import {
  OUT_OF,
  PASS_MARK,
  READY_SCORE,
  bandFor,
  estimatedSessionsToReady,
  questionProbability,
  readinessScore,
} from './readiness';

/** Fixed clock: 2026-06-10T18:00:00Z. */
const T0 = Date.UTC(2026, 5, 10, 18, 0, 0);

function prog(overrides: Partial<QuestionProgress> = {}): QuestionProgress {
  return { ...emptyProgress(T0), ...overrides };
}

function mastered(): QuestionProgress {
  return prog({ seen: 2, correct: 2, wrong: 0, consecutiveCorrect: 2, lastSeen: T0, dueAt: T0 + 1000 });
}

function mapFor(ids: readonly QuestionId[], value: QuestionProgress): ProgressMap {
  return Object.fromEntries(ids.map((id) => [id, value]));
}

const FEDERAL_IDS = federalQuestions().map((q) => q.id);

describe('questionProbability', () => {
  it('is a blind 1-in-4 guess for an unseen question', () => {
    expect(questionProbability(undefined)).toBe(0.25);
    expect(questionProbability(emptyProgress(T0))).toBe(0.25);
  });

  it('is monotonic across the mastery buckets for identical history', () => {
    const base = { seen: 4, correct: 3, wrong: 1, lastSeen: T0, dueAt: T0 + 1 };
    const learning = questionProbability(prog({ ...base, consecutiveCorrect: 0 }));
    const familiar = questionProbability(prog({ ...base, consecutiveCorrect: 1 }));
    const hinted = questionProbability(prog({ ...base, consecutiveCorrect: 2, hintsUsed: 1 }));
    const clean = questionProbability(prog({ ...base, consecutiveCorrect: 2 }));
    expect(learning).toBeLessThan(familiar);
    expect(familiar).toBe(hinted); // hinted stays in the familiar band
    expect(hinted).toBeLessThan(clean);
  });

  it('pulls a mastered-but-historically-shaky question down', () => {
    const shaky = questionProbability(
      prog({ seen: 12, correct: 5, wrong: 7, consecutiveCorrect: 2, lastSeen: T0, dueAt: T0 + 1 }),
    );
    expect(shaky).toBeLessThan(questionProbability(mastered()));
    expect(shaky).toBeGreaterThan(0.25);
  });

  it('never leaves the [0.1, 0.99] band', () => {
    const hopeless = questionProbability(
      prog({ seen: 30, correct: 0, wrong: 30, consecutiveCorrect: 0, lastSeen: T0, dueAt: T0 + 1 }),
    );
    const perfect = questionProbability(
      prog({ seen: 40, correct: 40, consecutiveCorrect: 40, lastSeen: T0, dueAt: T0 + 1 }),
    );
    expect(hopeless).toBeGreaterThanOrEqual(0.1);
    expect(hopeless).toBeLessThan(0.25);
    expect(perfect).toBeLessThanOrEqual(0.99);
  });
});

describe('readinessScore', () => {
  it('is 8.25 / 33 with no progress at all — a pure 25% guess', () => {
    const r = readinessScore('BW', {});
    expect(r.score).toBe(8.25);
    expect(r.outOf).toBe(33);
    expect(r.passMark).toBe(17);
    expect(r.federalComponent).toBe(7.5);
    expect(r.stateComponent).toBe(0.75);
    expect(r.band).toBe('notReady');
    expect(r.confidence).toBe(0);
    expect(OUT_OF).toBe(33);
    expect(PASS_MARK).toBe(17);
  });

  it('is >= 32 and solid once the whole active deck is mastered', () => {
    const progress = mapFor(
      activeDeck('BW').map((q) => q.id),
      mastered(),
    );
    const r = readinessScore('BW', progress);
    expect(r.score).toBeGreaterThanOrEqual(32);
    expect(r.score).toBeLessThanOrEqual(33);
    expect(r.band).toBe('solid');
    expect(r.confidence).toBe(1);
  });

  it('moves by at most ~3 points when only the 10 state questions are mastered', () => {
    const baseline = readinessScore('BW', {}).score;
    const progress = mapFor(
      stateQuestions('BW').map((q) => q.id),
      mastered(),
    );
    const boosted = readinessScore('BW', progress);
    expect(boosted.score).toBeGreaterThan(baseline);
    expect(boosted.score - baseline).toBeLessThanOrEqual(3);
    expect(boosted.federalComponent).toBe(7.5); // untouched
    expect(boosted.stateComponent).toBeGreaterThan(2.9);
  });

  it('caps the federal component at 30 and the state component at 3', () => {
    const everything = mapFor(
      activeDeck('BW').map((q) => q.id),
      prog({ seen: 40, correct: 40, consecutiveCorrect: 40, lastSeen: T0, dueAt: T0 + 1 }),
    );
    const r = readinessScore('BW', everything);
    expect(r.federalComponent).toBeLessThanOrEqual(30);
    expect(r.stateComponent).toBeLessThanOrEqual(3);
    expect(r.score).toBeLessThanOrEqual(33);
  });

  it('never drops below 0', () => {
    const awful = mapFor(
      activeDeck('BW').map((q) => q.id),
      prog({ seen: 20, correct: 0, wrong: 20, consecutiveCorrect: 0, lastSeen: T0, dueAt: T0 + 1 }),
    );
    const r = readinessScore('BW', awful);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThan(8.25);
    expect(r.band).toBe('notReady');
  });

  it('changes with the selected state while federal progress stays put', () => {
    const progress = mapFor(
      [...FEDERAL_IDS, ...stateQuestions('BY').map((q) => q.id)],
      mastered(),
    );
    const bavaria = readinessScore('BY', progress);
    const baden = readinessScore('BW', progress);

    expect(bavaria.federalComponent).toBe(baden.federalComponent);
    expect(bavaria.score).toBeGreaterThan(baden.score);
    expect(baden.stateComponent).toBe(0.75); // BW's 10 questions untouched
    expect(bavaria.stateComponent).toBeGreaterThan(2.9);
  });

  it('reflects only the active state for all 16 states', () => {
    for (const state of STATE_CODES) {
      const progress = mapFor(
        stateQuestions(state).map((q) => q.id),
        mastered(),
      );
      const r = readinessScore(state, progress);
      expect(r.stateComponent).toBeGreaterThan(2.9);
      expect(r.federalComponent).toBe(7.5);
      expect(r.score).toBeLessThanOrEqual(33);
    }
  });

  it('reports rising confidence as questions get answered', () => {
    const half = mapFor(FEDERAL_IDS.slice(0, 155), mastered());
    const r = readinessScore('BW', half);
    expect(r.confidence).toBeGreaterThan(0.4);
    expect(r.confidence).toBeLessThan(0.6);
  });
});

describe('bandFor', () => {
  it('uses the 17-point pass mark as the notReady boundary', () => {
    expect(bandFor(0)).toBe('notReady');
    expect(bandFor(16.99)).toBe('notReady');
    expect(bandFor(17)).toBe('borderline');
    expect(bandFor(20.99)).toBe('borderline');
    expect(bandFor(21)).toBe('ready');
    expect(bandFor(27.99)).toBe('ready');
    expect(bandFor(28)).toBe('solid');
    expect(bandFor(33)).toBe('solid');
  });
});

describe('estimatedSessionsToReady', () => {
  it('is a positive number of sessions from a cold start', () => {
    const estimate = estimatedSessionsToReady('BW', {});
    expect(estimate).not.toBeNull();
    expect(estimate ?? 0).toBeGreaterThan(0);
  });

  it('shrinks as the user improves', () => {
    const cold = estimatedSessionsToReady('BW', {}) ?? 0;
    const warm = estimatedSessionsToReady('BW', mapFor(FEDERAL_IDS.slice(0, 150), mastered())) ?? 0;
    expect(warm).toBeGreaterThan(0);
    expect(warm).toBeLessThan(cold);
  });

  it('is null once the user is ready', () => {
    const progress = mapFor(
      activeDeck('BW').map((q) => q.id),
      mastered(),
    );
    expect(readinessScore('BW', progress).score).toBeGreaterThanOrEqual(READY_SCORE);
    expect(estimatedSessionsToReady('BW', progress)).toBeNull();
  });
});
