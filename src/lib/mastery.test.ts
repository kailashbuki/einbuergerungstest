import { describe, expect, it } from 'vitest';
import type { AnswerRecord, Question, QuestionId, QuestionProgress } from '@/types';
import { activeDeck } from './deck';
import { emptyProgress, type ProgressMap } from './progressModel';
import {
  CLEAR_THRESHOLD,
  categoryStrength,
  isLevelCleared,
  levelProgressPercent,
  levelStars,
  masteryCounts,
  masteryOf,
} from './mastery';

/** Fixed clock: 2026-01-20T12:00:00Z. */
const T0 = Date.UTC(2026, 0, 20, 12, 0, 0);

function prog(overrides: Partial<QuestionProgress> = {}): QuestionProgress {
  return { ...emptyProgress(T0), ...overrides };
}

/** A question that has been answered `streak` times in a row, optionally with hints. */
function streak(consecutiveCorrect: number, hintsUsed = 0): QuestionProgress {
  return prog({
    seen: consecutiveCorrect,
    correct: consecutiveCorrect,
    wrong: 0,
    consecutiveCorrect,
    hintsUsed,
    lastSeen: T0,
    dueAt: T0 + 1000,
  });
}

const DECK: readonly Question[] = activeDeck('BW');
const LEVEL: readonly QuestionId[] = DECK.slice(0, 10).map((q) => q.id);

function answer(questionId: QuestionId, correct: boolean): AnswerRecord {
  return { questionId, chosen: correct ? 'a' : 'b', correct, hintsUsed: 0, ms: 3000 };
}

function levelId(index: number): QuestionId {
  const id = LEVEL[index];
  if (id === undefined) throw new Error(`level fixture has no index ${index}`);
  return id;
}

/** Give the first `count` questions of the level the supplied progress. */
function firstN(count: number, value: QuestionProgress): ProgressMap {
  const entries: [QuestionId, QuestionProgress][] = [];
  for (let i = 0; i < count; i += 1) entries.push([levelId(i), value]);
  return Object.fromEntries(entries);
}

describe('masteryOf', () => {
  it('treats missing and unseen progress as new', () => {
    expect(masteryOf(undefined)).toBe('new');
    expect(masteryOf(emptyProgress(T0))).toBe('new');
    // Defensive: a row with counters but seen === 0 is still "new".
    expect(masteryOf(prog({ consecutiveCorrect: 5, seen: 0 }))).toBe('new');
  });

  it('is learning when the last answer was wrong', () => {
    expect(masteryOf(prog({ seen: 1, wrong: 1, lastSeen: T0 }))).toBe('learning');
    expect(masteryOf(prog({ seen: 9, correct: 8, wrong: 1, consecutiveCorrect: 0, lastSeen: T0 }))).toBe(
      'learning',
    );
  });

  it('is familiar at exactly one consecutive correct', () => {
    expect(masteryOf(streak(1))).toBe('familiar');
  });

  it('is mastered at exactly two consecutive correct with no hints', () => {
    expect(masteryOf(streak(2))).toBe('mastered');
    expect(masteryOf(streak(7))).toBe('mastered');
  });

  it('keeps a hinted-but-twice-correct question at familiar, NOT mastered', () => {
    expect(masteryOf(streak(2, 1))).toBe('familiar');
    expect(masteryOf(streak(9, 1))).toBe('familiar');
  });
});

describe('masteryCounts', () => {
  it('counts every deck question exactly once', () => {
    const counts = masteryCounts(DECK, {});
    expect(counts).toEqual({ new: 310, learning: 0, familiar: 0, mastered: 0 });
  });

  it('splits the deck across all four buckets', () => {
    const progress: ProgressMap = {
      [levelId(0)]: prog({ seen: 1, wrong: 1, lastSeen: T0 }),
      [levelId(1)]: streak(1),
      [levelId(2)]: streak(2, 4),
      [levelId(3)]: streak(2),
      [levelId(4)]: streak(5),
    };
    expect(masteryCounts(DECK, progress)).toEqual({
      new: 305,
      learning: 1,
      familiar: 2,
      mastered: 2,
    });
  });
});

describe('levelProgressPercent / isLevelCleared', () => {
  it('clears at exactly 7/10 and not at 6/10', () => {
    expect(CLEAR_THRESHOLD).toBe(0.7);

    const seven = firstN(7, streak(1));
    expect(levelProgressPercent(LEVEL, seven)).toBe(70);
    expect(isLevelCleared(LEVEL, seven)).toBe(true);

    const six = firstN(6, streak(1));
    expect(levelProgressPercent(LEVEL, six)).toBe(60);
    expect(isLevelCleared(LEVEL, six)).toBe(false);
  });

  it('is 0 for an untouched level and 100 when all current', () => {
    expect(levelProgressPercent(LEVEL, {})).toBe(0);
    expect(levelProgressPercent(LEVEL, firstN(10, streak(1)))).toBe(100);
    expect(levelProgressPercent([], {})).toBe(0);
    expect(isLevelCleared([], {})).toBe(false);
  });

  it('does not count a question whose last answer was wrong', () => {
    const progress: ProgressMap = {
      ...firstN(7, streak(1)),
      [levelId(0)]: prog({ seen: 4, correct: 3, wrong: 1, consecutiveCorrect: 0, lastSeen: T0 }),
    };
    expect(levelProgressPercent(LEVEL, progress)).toBe(60);
    expect(isLevelCleared(LEVEL, progress)).toBe(false);
  });

  it('can be cleared by a past pass alone', () => {
    const pass = LEVEL.slice(0, 8).map((id) => answer(id, true));
    expect(isLevelCleared(LEVEL, {}, pass)).toBe(true);
    expect(isLevelCleared(LEVEL, {}, LEVEL.slice(0, 6).map((id) => answer(id, true)))).toBe(false);
  });
});

describe('levelStars', () => {
  it('is 0 for an empty or untouched level', () => {
    expect(levelStars([], {})).toBe(0);
    expect(levelStars(LEVEL, {})).toBe(0);
    expect(levelStars(LEVEL, firstN(6, streak(1)))).toBe(0);
  });

  it('is 1 at the 70% clear bar', () => {
    expect(levelStars(LEVEL, firstN(7, streak(1)))).toBe(1);
  });

  it('is 2 for a clean single pass over the whole level', () => {
    const pass = LEVEL.map((id) => answer(id, true));
    expect(levelStars(LEVEL, firstN(10, streak(1, 1)), pass)).toBe(2);
  });

  it('is not 2 when the pass missed a question or skipped one', () => {
    const oneWrong = LEVEL.map((id, i) => answer(id, i !== 3));
    expect(levelStars(LEVEL, firstN(10, streak(1, 1)), oneWrong)).toBe(1);

    const partial = LEVEL.slice(0, 9).map((id) => answer(id, true));
    expect(levelStars(LEVEL, firstN(10, streak(1, 1)), partial)).toBe(1);
  });

  it('is not 2 when a question was retried inside the same pass', () => {
    const retried = [
      ...LEVEL.map((id) => answer(id, true)),
      answer(levelId(2), false), // second attempt at the same question, wrong
    ];
    expect(levelStars(LEVEL, firstN(10, streak(1, 1)), retried)).toBe(1);
  });

  it('is 3 only when every question is mastered with zero hints', () => {
    expect(levelStars(LEVEL, firstN(10, streak(2)))).toBe(3);
    expect(levelStars(LEVEL, firstN(10, streak(5)))).toBe(3);

    const oneHinted: ProgressMap = { ...firstN(10, streak(3)), [levelId(4)]: streak(3, 1) };
    expect(levelStars(LEVEL, oneHinted)).toBe(1);
    expect(levelStars(LEVEL, oneHinted, LEVEL.map((id) => answer(id, true)))).toBe(2);
  });

  it('is 3 without a pass record — mastery is stronger evidence than a clean pass', () => {
    expect(levelStars(LEVEL, firstN(10, streak(2)), undefined)).toBe(3);
  });

  it('is 3 only when the whole level is mastered, not most of it', () => {
    const nine: ProgressMap = { ...firstN(9, streak(2)) };
    expect(levelStars(LEVEL, nine)).toBe(1);
  });
});

describe('categoryStrength', () => {
  it('returns every category present in the deck, weakest first', () => {
    const rows = categoryStrength(DECK, {});
    expect(rows.map((r) => r.category).sort()).toEqual(
      [...new Set(DECK.map((q) => q.category))].sort(),
    );
    expect(rows.every((r) => r.strength === 0)).toBe(true);
    // All equally weak, so the tiebreak puts the biggest category first.
    expect(rows[0]?.category).toBe('general');
    expect(rows[0]?.total).toBe(172);
  });

  it('sorts ascending by strength and pushes a mastered category last', () => {
    const target = 'elections';
    const progress: ProgressMap = Object.fromEntries(
      DECK.filter((q) => q.category === target).map((q) => [q.id, streak(3)]),
    );
    const rows = categoryStrength(DECK, progress);

    for (let i = 1; i < rows.length; i += 1) {
      const previous = rows[i - 1];
      const current = rows[i];
      if (previous === undefined || current === undefined) throw new Error('bad row');
      expect(current.strength).toBeGreaterThanOrEqual(previous.strength);
    }

    const last = rows[rows.length - 1];
    expect(last?.category).toBe(target);
    expect(last?.strength).toBe(1);
    expect(last?.counts.mastered).toBe(12);
  });

  it('ranks a half-learned category between an untouched and a mastered one', () => {
    const constitutionIds = DECK.filter((q) => q.category === 'constitution').map((q) => q.id);
    const electionIds = DECK.filter((q) => q.category === 'elections').map((q) => q.id);
    const progress: ProgressMap = {
      ...Object.fromEntries(constitutionIds.map((id) => [id, streak(1)])),
      ...Object.fromEntries(electionIds.map((id) => [id, streak(2)])),
    };
    const rows = categoryStrength(DECK, progress);
    const order = rows.map((r) => r.category);
    expect(order.indexOf('general')).toBeLessThan(order.indexOf('constitution'));
    expect(order.indexOf('constitution')).toBeLessThan(order.indexOf('elections'));
    expect(rows.find((r) => r.category === 'constitution')?.strength).toBeCloseTo(0.65, 10);
  });
});
