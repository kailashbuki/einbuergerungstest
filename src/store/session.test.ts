// jsdom has no IndexedDB; this installs an in-memory implementation on
// globalThis and must come before anything that opens the database.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_HINTS,
  REQUEUE_GAP,
  canRequeue,
  correctCount,
  currentSlot,
  currentStreak,
  eliminatedOptions,
  sessionAnswers,
  useSessionStore,
  xpFor,
} from './session';
import { useAppStore } from './index';
import { closeDb, deleteDb } from '@/lib/db';
import { federalQuestions } from '@/lib/deck';
import { masteryOf } from '@/lib/mastery';
import { OPTION_KEYS, type QuestionId } from '@/types';

async function freshStore(): Promise<void> {
  await closeDb();
  await deleteDb();
  useAppStore.setState({
    hydrated: false,
    settings: {
      state: 'BW',
      uiLocale: 'en',
      translation: 'off',
      alwaysShowTranslation: false,
      mockTranslations: false,
      recallFirst: true,
      tts: false,
      ttsAutoplay: false,
      theme: 'system',
      onboarded: true,
      updatedAt: 0,
    },
    progress: {},
    sessions: [],
    mocks: [],
    practiceDays: {},
    badges: {},
    xp: 0,
  });
  await useAppStore.getState().hydrate();
  useSessionStore.getState().reset();
}

beforeEach(async () => {
  await freshStore();
});

const deck = federalQuestions();
const ids: readonly QuestionId[] = deck.slice(0, 4).map((q) => q.id);

function startThree(recallFirst = true): void {
  useSessionStore.getState().start({
    mode: 'learn',
    levelId: 'w1-l1',
    questionIds: ids.slice(0, 3),
    recallFirst,
    now: 1_000,
  });
}

describe('hint ladder', () => {
  it('increments one step at a time and stops at three', () => {
    startThree();
    const s = () => useSessionStore.getState();

    expect(currentSlot(s())?.hintsUsed).toBe(0);

    s().useHint();
    expect(currentSlot(s())?.hintsUsed).toBe(1);
    s().useHint();
    expect(currentSlot(s())?.hintsUsed).toBe(2);
    s().useHint();
    expect(currentSlot(s())?.hintsUsed).toBe(MAX_HINTS);

    // The fourth press must be inert: there is no hint beyond "show the answer",
    // and letting the counter drift would over-charge the XP penalty.
    s().useHint();
    s().useHint();
    expect(currentSlot(s())?.hintsUsed).toBe(MAX_HINTS);
  });

  it('reveals the options, because a hint against hidden options is useless', () => {
    startThree(true);
    expect(currentSlot(useSessionStore.getState())?.optionsRevealed).toBe(false);
    useSessionStore.getState().useHint();
    expect(currentSlot(useSessionStore.getState())?.optionsRevealed).toBe(true);
  });

  it('refuses further hints once the question has been answered', () => {
    startThree();
    const s = () => useSessionStore.getState();
    s().useHint();
    s().submit('a', true, 2_000);
    s().useHint();
    expect(currentSlot(s())?.hintsUsed).toBe(1);
  });

  it('gives a requeued question its own fresh hint budget', () => {
    startThree();
    const s = () => useSessionStore.getState();
    const first = ids[0];
    expect(first).toBeDefined();

    s().useHint();
    s().useHint();
    s().submit('a', false, 2_000);
    s().requeueCurrent();

    // Same question, later slot, hint count back to zero: the retry's cost has
    // to be honest about what the retry itself cost.
    const retryAt = Math.min(0 + REQUEUE_GAP, 3);
    const retry = s().slots[retryAt];
    expect(retry?.questionId).toBe(first);
    expect(retry?.hintsUsed).toBe(0);
    expect(retry?.requeue).toBe(true);

    // And it is offered exactly once.
    expect(canRequeue(s(), first as QuestionId)).toBe(false);
    s().requeueCurrent();
    expect(s().slots).toHaveLength(4);
  });
});

describe('hint cost reaching the app store', () => {
  it('accumulates hintsUsed across attempts and permanently blocks three stars', async () => {
    const question = deck[0];
    expect(question).toBeDefined();
    if (question === undefined) return;

    const app = () => useAppStore.getState();

    // Correct, but it took two hints.
    await app().answer(question.id, { correct: true, hintsUsed: 2 });
    expect(app().progress[question.id]?.hintsUsed).toBe(2);
    expect(app().progress[question.id]?.consecutiveCorrect).toBe(1);

    // Correct again, clean this time. The streak reaches the mastery threshold…
    await app().answer(question.id, { correct: true, hintsUsed: 0 });
    const after = app().progress[question.id];
    expect(after?.consecutiveCorrect).toBe(2);
    // …but the lifetime hint count is cumulative and never resets, so the
    // question can never reach 'mastered'. That permanence is the whole point of
    // making a hint a real trade rather than a free peek.
    expect(after?.hintsUsed).toBe(2);
    expect(masteryOf(after)).not.toBe('mastered');
  });

  it('charges XP per hint but never drops a correct answer to zero', () => {
    expect(xpFor([{ questionId: 'x', chosen: 'a', correct: true, hintsUsed: 0, ms: 10 }])).toBe(10);
    expect(xpFor([{ questionId: 'x', chosen: 'a', correct: true, hintsUsed: 1, ms: 10 }])).toBe(7);
    expect(xpFor([{ questionId: 'x', chosen: 'a', correct: true, hintsUsed: 3, ms: 10 }])).toBe(1);
    expect(xpFor([{ questionId: 'x', chosen: 'b', correct: false, hintsUsed: 0, ms: 10 }])).toBe(0);
  });
});

describe('eliminatedOptions', () => {
  it('eliminates nothing before step 2 and never touches the solution', () => {
    for (const question of deck.slice(0, 40)) {
      expect(eliminatedOptions(question.id, question.solution, 0)).toEqual([]);
      expect(eliminatedOptions(question.id, question.solution, 1)).toEqual([]);
      for (const step of [2, 3, 9]) {
        expect(eliminatedOptions(question.id, question.solution, step)).not.toContain(
          question.solution,
        );
      }
    }
  });

  it('leaves a real 50/50 at step 2 and only the answer at step 3', () => {
    for (const question of deck.slice(0, 40)) {
      expect(eliminatedOptions(question.id, question.solution, 2)).toHaveLength(2);
      const final = eliminatedOptions(question.id, question.solution, MAX_HINTS);
      expect(final).toHaveLength(OPTION_KEYS.length - 1);
      expect([...final].sort()).toEqual(
        OPTION_KEYS.filter((k) => k !== question.solution)
          .slice()
          .sort(),
      );
    }
  });

  it('is deterministic per question, so a hint cannot be re-rolled', () => {
    const question = deck[0];
    expect(question).toBeDefined();
    if (question === undefined) return;
    const first = eliminatedOptions(question.id, question.solution, 2);
    for (let i = 0; i < 25; i += 1) {
      expect(eliminatedOptions(question.id, question.solution, 2)).toEqual(first);
    }
  });

  it('does not eliminate the same letters for every question', () => {
    // A seed that ignored the id would strike out identical letters everywhere,
    // which would be trivially gameable.
    const shapes = new Set(
      deck.slice(0, 60).map((q) => [...eliminatedOptions(q.id, q.solution, 2)].sort().join('')),
    );
    expect(shapes.size).toBeGreaterThan(1);
  });
});

describe('queue bookkeeping', () => {
  it('records only answered slots, in order', () => {
    startThree();
    const s = () => useSessionStore.getState();
    s().submit('a', true, 1_500);
    s().advance(1_500);
    s().submit('b', false, 3_000);
    // Third slot deliberately left unanswered (the user quit here).

    const answers = sessionAnswers(s());
    expect(answers).toHaveLength(2);
    expect(answers.map((a) => a.correct)).toEqual([true, false]);
    expect(answers[0]?.questionId).toBe(ids[0]);
    expect(answers[0]?.ms).toBe(500);
    expect(correctCount(s())).toBe(1);
    expect(currentStreak(s())).toBe(0);
  });

  it('ignores a double submit on the same slot', () => {
    startThree();
    const s = () => useSessionStore.getState();
    s().submit('a', true, 1_500);
    s().submit('b', false, 1_900);
    expect(currentSlot(s())?.chosen).toBe('a');
    expect(sessionAnswers(s())).toHaveLength(1);
  });

  it('finishes past the end of the queue and resets to inactive', () => {
    startThree();
    const s = () => useSessionStore.getState();
    s().advance(2_000);
    s().advance(3_000);
    expect(s().finished).toBe(false);
    s().advance(4_000);
    expect(s().finished).toBe(true);

    s().reset();
    expect(s().active).toBe(false);
    expect(s().slots).toEqual([]);
  });

  it('treats an empty queue as immediately finished', () => {
    useSessionStore
      .getState()
      .start({ mode: 'drill', levelId: null, questionIds: [], recallFirst: true, now: 1 });
    expect(useSessionStore.getState().finished).toBe(true);
    expect(sessionAnswers(useSessionStore.getState())).toEqual([]);
  });
});
