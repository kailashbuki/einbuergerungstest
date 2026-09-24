import { describe, expect, it } from 'vitest';
import type { Question, QuestionProgress } from '@/types';
import { activeDeck } from './deck';
import { emptyProgress, recordAnswer, type ProgressMap } from './progressModel';
import {
  DAY_MS,
  DEFAULT_EASE,
  EASE_BONUS,
  EASE_PENALTY,
  LEARNING_STEPS_MS,
  MAX_EASE,
  MAX_INTERVAL_MS,
  MINUTE_MS,
  MIN_EASE,
  NEMESIS_WRONG_THRESHOLD,
  buildDrill,
  buildNemesis,
  dueQuestions,
  isDue,
  nextEase,
  nextInterval,
  schedule,
  seededRng,
} from './scheduler';

/** Fixed clock: 2026-03-01T09:00:00Z. Never Date.now() in assertions. */
const T0 = Date.UTC(2026, 2, 1, 9, 0, 0);

function prog(overrides: Partial<QuestionProgress> = {}): QuestionProgress {
  return { ...emptyProgress(T0), ...overrides };
}

const DECK: readonly Question[] = activeDeck('BW');
const SMALL: readonly Question[] = DECK.slice(0, 5);
const ids = (questions: readonly Question[]): readonly string[] => questions.map((q) => q.id);

describe('nextInterval / schedule', () => {
  it('walks the explicit ladder and then grows multiplicatively', () => {
    const p0 = emptyProgress(T0);
    expect(nextInterval(p0, true)).toBe(10 * MINUTE_MS);

    const p1 = recordAnswer(p0, { correct: true, hintsUsed: 0, now: T0 });
    expect(p1.dueAt).toBe(T0 + 10 * MINUTE_MS);
    expect(nextInterval(p1, true)).toBe(DAY_MS);

    const t2 = p1.dueAt;
    const p2 = recordAnswer(p1, { correct: true, hintsUsed: 0, now: t2 });
    expect(p2.dueAt).toBe(t2 + DAY_MS);
    expect(nextInterval(p2, true)).toBe(3 * DAY_MS);

    const t3 = p2.dueAt;
    const p3 = recordAnswer(p2, { correct: true, hintsUsed: 0, now: t3 });
    expect(p3.dueAt).toBe(t3 + 3 * DAY_MS);

    // Past the ladder: previous interval (3d) x the new ease (~2.70).
    expect(p3.ease).toBeCloseTo(DEFAULT_EASE + 3 * EASE_BONUS, 10);
    const grownEase = p3.ease + EASE_BONUS;
    expect(grownEase).toBeCloseTo(2.7, 10);
    expect(nextInterval(p3, true)).toBe(Math.round(3 * DAY_MS * grownEase));
    expect(nextInterval(p3, true)).toBeGreaterThan(3 * DAY_MS);
    expect(nextInterval(p3, true) / DAY_MS).toBeCloseTo(8.1, 3);
  });

  it('brings a freshly learned question back inside the same day', () => {
    expect(LEARNING_STEPS_MS[0]).toBe(10 * MINUTE_MS);
    const first = schedule(emptyProgress(T0), true, T0);
    expect(first.dueAt - T0).toBeLessThan(DAY_MS);
  });

  it('grows strictly on a long correct streak', () => {
    let p = emptyProgress(T0);
    let now = T0;
    let previous = 0;
    for (let i = 0; i < 8; i += 1) {
      p = recordAnswer(p, { correct: true, hintsUsed: 0, now });
      const interval = p.dueAt - now;
      expect(interval).toBeGreaterThanOrEqual(previous);
      previous = interval;
      now = p.dueAt;
    }
    expect(previous).toBeGreaterThan(30 * DAY_MS);
  });

  it('caps the interval so nothing is parked past the exam horizon', () => {
    const veteran = prog({ consecutiveCorrect: 20, lastSeen: T0, dueAt: T0 + 5000 * DAY_MS, ease: MAX_EASE });
    expect(nextInterval(veteran, true)).toBe(MAX_INTERVAL_MS);
  });

  it('resets to the shortest step and drops ease on a wrong answer', () => {
    const strong = prog({ consecutiveCorrect: 6, lastSeen: T0, dueAt: T0 + 40 * DAY_MS, ease: 2.7 });
    expect(nextInterval(strong, false)).toBe(10 * MINUTE_MS);

    const after = schedule(strong, false, T0 + 41 * DAY_MS);
    expect(after.dueAt).toBe(T0 + 41 * DAY_MS + 10 * MINUTE_MS);
    expect(after.ease).toBeCloseTo(2.7 - EASE_PENALTY, 10);
  });

  it('respects the ease floor', () => {
    expect(nextEase(prog({ ease: MIN_EASE + 0.05 }), false)).toBe(MIN_EASE);
    expect(nextEase(prog({ ease: MIN_EASE }), false)).toBe(MIN_EASE);
    let p = prog({ ease: DEFAULT_EASE });
    for (let i = 0; i < 20; i += 1) p = { ...p, ease: nextEase(p, false) };
    expect(p.ease).toBe(MIN_EASE);
  });

  it('respects the ease cap', () => {
    expect(nextEase(prog({ ease: MAX_EASE - 0.01 }), true)).toBe(MAX_EASE);
    expect(nextEase(prog({ ease: MAX_EASE }), true)).toBe(MAX_EASE);
    let p = prog({ ease: DEFAULT_EASE });
    for (let i = 0; i < 50; i += 1) p = { ...p, ease: nextEase(p, true) };
    expect(p.ease).toBe(MAX_EASE);
  });

  it('repairs a corrupt ease instead of propagating NaN', () => {
    expect(nextEase(prog({ ease: Number.NaN }), true)).toBeCloseTo(DEFAULT_EASE + EASE_BONUS, 10);
  });
});

describe('dueQuestions', () => {
  it('treats never-seen questions as due', () => {
    expect(isDue(undefined, T0)).toBe(true);
    expect(isDue(emptyProgress(T0), T0)).toBe(true);
    expect(dueQuestions(SMALL, {}, T0)).toHaveLength(SMALL.length);
  });

  it('excludes a question scheduled into the future', () => {
    const first = SMALL[0];
    if (first === undefined) throw new Error('fixture deck is empty');
    const progress: ProgressMap = {
      [first.id]: prog({ seen: 1, correct: 1, consecutiveCorrect: 1, lastSeen: T0, dueAt: T0 + DAY_MS }),
    };
    expect(ids(dueQuestions(SMALL, progress, T0))).not.toContain(first.id);
    expect(ids(dueQuestions(SMALL, progress, T0 + DAY_MS))).toContain(first.id);
  });
});

describe('buildDrill', () => {
  function idAt(index: number): string {
    const q = SMALL[index];
    if (q === undefined) throw new Error(`fixture deck has no index ${index}`);
    return q.id;
  }

  it('puts a high-wrong-count question ahead of never-seen ones', () => {
    const progress: ProgressMap = {
      [idAt(4)]: prog({
        seen: 5,
        correct: 1,
        wrong: 4,
        consecutiveCorrect: 0,
        lastSeen: T0 - 1000,
        dueAt: T0 + DAY_MS, // not overdue — the wrong count alone must carry it
      }),
    };
    expect(ids(buildDrill(SMALL, progress, T0, 3))[0]).toBe(idAt(4));
  });

  it('puts an overdue question ahead of a merely wrong one', () => {
    const progress: ProgressMap = {
      [idAt(3)]: prog({
        seen: 1,
        correct: 1,
        consecutiveCorrect: 1,
        lastSeen: T0 - 3 * DAY_MS,
        dueAt: T0 - 2 * DAY_MS,
      }),
      [idAt(4)]: prog({
        seen: 5,
        correct: 1,
        wrong: 4,
        consecutiveCorrect: 0,
        lastSeen: T0 - 1000,
        dueAt: T0 + DAY_MS,
      }),
    };
    expect(ids(buildDrill(SMALL, progress, T0, 5)).slice(0, 2)).toEqual([idAt(3), idAt(4)]);
  });

  it('prefers a lower streak among otherwise equal questions', () => {
    const progress: ProgressMap = {
      [idAt(0)]: prog({ seen: 4, correct: 4, consecutiveCorrect: 4, lastSeen: T0, dueAt: T0 }),
      [idAt(1)]: prog({ seen: 1, correct: 1, consecutiveCorrect: 1, lastSeen: T0, dueAt: T0 }),
    };
    const order = ids(buildDrill(SMALL, progress, T0, 5));
    expect(order.indexOf(idAt(1))).toBeLessThan(order.indexOf(idAt(0)));
  });

  it('is deterministic across repeated calls', () => {
    const progress: ProgressMap = {
      [idAt(1)]: prog({ seen: 3, correct: 1, wrong: 2, lastSeen: T0 - 500, dueAt: T0 - 10 }),
      [idAt(2)]: prog({ seen: 9, correct: 4, wrong: 5, lastSeen: T0 - 400, dueAt: T0 - 20 }),
    };
    const a = ids(buildDrill(DECK, progress, T0));
    const b = ids(buildDrill(DECK, progress, T0));
    const c = ids(buildDrill(DECK, progress, T0));
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('respects size and never repeats a question', () => {
    const drill = buildDrill(DECK, {}, T0, 10);
    expect(drill).toHaveLength(10);
    expect(new Set(ids(drill)).size).toBe(10);

    expect(buildDrill(DECK, {}, T0, 0)).toHaveLength(0);
    expect(buildDrill(DECK, {}, T0, -5)).toHaveLength(0);
    expect(buildDrill(SMALL, {}, T0, 99)).toHaveLength(SMALL.length);

    const duplicated = [...SMALL, ...SMALL];
    const deduped = buildDrill(duplicated, {}, T0, 10);
    expect(new Set(ids(deduped)).size).toBe(deduped.length);
    expect(deduped).toHaveLength(SMALL.length);
  });

  it('shuffles only within equally weak groups when given a seeded rng', () => {
    const progress: ProgressMap = {
      [idAt(2)]: prog({ seen: 6, correct: 1, wrong: 5, lastSeen: T0 - 100, dueAt: T0 - 10 }),
    };
    const seeded = ids(buildDrill(DECK, progress, T0, 10, seededRng(42)));
    const sameSeed = ids(buildDrill(DECK, progress, T0, 10, seededRng(42)));
    expect(seeded).toEqual(sameSeed);
    // The single weakest question stays pinned to the front.
    expect(seeded[0]).toBe(idAt(2));
    // ...but the tied never-seen tail is reordered relative to the default path.
    expect(seeded).not.toEqual(ids(buildDrill(DECK, progress, T0, 10)));
    expect(new Set(seeded).size).toBe(10);
  });

  it('still returns a full drill when everything is mastered', () => {
    const progress: ProgressMap = Object.fromEntries(
      DECK.map((q) => [
        q.id,
        prog({ seen: 3, correct: 3, consecutiveCorrect: 3, lastSeen: T0, dueAt: T0 + 30 * DAY_MS }),
      ]),
    );
    expect(buildDrill(DECK, progress, T0, 10)).toHaveLength(10);
  });
});

describe('buildNemesis', () => {
  function idAt(index: number): string {
    const q = DECK[index];
    if (q === undefined) throw new Error(`fixture deck has no index ${index}`);
    return q.id;
  }

  it('uses a >= 3 wrong threshold', () => {
    expect(NEMESIS_WRONG_THRESHOLD).toBe(3);
    const progress: ProgressMap = {
      [idAt(0)]: prog({ seen: 4, correct: 2, wrong: 2, lastSeen: T0 }),
      [idAt(1)]: prog({ seen: 5, correct: 2, wrong: 3, lastSeen: T0 }),
      [idAt(2)]: prog({ seen: 9, correct: 2, wrong: 7, lastSeen: T0 }),
    };
    expect(ids(buildNemesis(DECK, progress))).toEqual([idAt(2), idAt(1)]);
  });

  it('is empty when nothing has been missed three times', () => {
    expect(buildNemesis(DECK, {})).toHaveLength(0);
    expect(buildNemesis(DECK, { [idAt(0)]: prog({ seen: 2, wrong: 2, lastSeen: T0 }) })).toHaveLength(0);
  });

  it('breaks ties on accuracy and respects size', () => {
    const progress: ProgressMap = {
      [idAt(0)]: prog({ seen: 10, correct: 7, wrong: 3, lastSeen: T0 }),
      [idAt(1)]: prog({ seen: 4, correct: 1, wrong: 3, lastSeen: T0 }),
      [idAt(2)]: prog({ seen: 6, correct: 3, wrong: 3, lastSeen: T0 }),
    };
    expect(ids(buildNemesis(DECK, progress))).toEqual([idAt(1), idAt(2), idAt(0)]);
    expect(buildNemesis(DECK, progress, 2)).toHaveLength(2);
    expect(buildNemesis(DECK, progress, 0)).toHaveLength(0);
  });
});
