// Runtime-only session state.
//
// NOTHING in this module is persisted. The durable record of a study session is
// the `SessionResult` that `src/routes/Session.tsx` hands to the app store's
// `finishSession`; everything here (where we are in the queue, which options are
// revealed, how many hints this attempt cost) exists only for as long as the
// screen is mounted. Reloading the page legitimately throws it away — that is
// why the drill runner is configured by search params instead.
//
// The queue is modelled as a list of *slots* rather than a list of question ids.
// A requeued question occupies a second, independent slot: its hint count and
// its timing belong to that attempt alone, so the `AnswerRecord` we emit for the
// retry is honest about what the retry actually cost. `hintsUsed` accumulating
// over the question's lifetime is the app store's job (see `recordAnswer`), not
// ours.

import { create } from 'zustand';
import { seededRng } from '@/lib/scheduler';
import { OPTION_KEYS, type AnswerRecord, type OptionKey, type QuestionId, type SessionMode } from '@/types';

/** Hint ladder length: category → eliminate two → show the answer. */
export const MAX_HINTS = 3;

/** `fb.requeue` promises "again in 3 questions", so that is where the retry lands. */
export const REQUEUE_GAP = 3;

/** XP for a clean correct answer. */
export const XP_PER_CORRECT = 10;
/** Each hint shaves this much off the answer's XP, floored at 1 — hints cost, but never nothing. */
export const XP_HINT_PENALTY = 3;

/* ────────────────────────────── hint helpers ────────────────────────────── */

/**
 * FNV-1a over the question id. The hint eliminator must pick the *same* two
 * wrong options every time a given question is shown, otherwise a user could
 * re-roll the hint by leaving and coming back until the distractor they were
 * unsure about got removed. Seeding from the id (never from the clock or from
 * `Math.random`) is what makes that impossible.
 */
export function seedFromQuestionId(id: QuestionId): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Which options the hint ladder has struck out at `step`.
 *
 * - steps 0–1 eliminate nothing (step 1 only names the topic).
 * - step 2 removes two of the three wrong options, leaving the correct answer
 *   and one distractor — a real 50/50 rather than a giveaway.
 * - step 3 removes the last distractor too, which is exactly what
 *   `hint.3.title` ("Show the answer") promises.
 *
 * Pure and deterministic in `(solution, questionId, step)`.
 */
export function eliminatedOptions(
  questionId: QuestionId,
  solution: OptionKey,
  step: number,
): readonly OptionKey[] {
  const wrong = OPTION_KEYS.filter((key) => key !== solution);
  if (step >= MAX_HINTS) return wrong;
  if (step < 2) return [];

  const rng = seededRng(seedFromQuestionId(questionId));
  const pool = [...wrong];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = pool[i];
    const b = pool[j];
    if (a === undefined || b === undefined) continue;
    pool[i] = b;
    pool[j] = a;
  }
  return pool.slice(0, 2);
}

/* ─────────────────────────────── the slice ──────────────────────────────── */

export interface SessionSlot {
  readonly questionId: QuestionId;
  /** Hints revealed for *this attempt*, 0–{@link MAX_HINTS}. */
  readonly hintsUsed: number;
  readonly optionsRevealed: boolean;
  readonly chosen: OptionKey | null;
  readonly answered: boolean;
  readonly correct: boolean;
  /** Epoch ms this slot was first shown; 0 until it is reached. */
  readonly startedAt: number;
  readonly ms: number;
  /** True when this slot is the retry of an earlier wrong answer. */
  readonly requeue: boolean;
}

export interface StartInput {
  readonly mode: SessionMode;
  readonly levelId: string | null;
  readonly questionIds: readonly QuestionId[];
  /** Hides the options on first render of every slot. */
  readonly recallFirst: boolean;
  readonly now: number;
}

export interface SessionSliceState {
  /** False before `start` and after `reset` — the runner must not render a question then. */
  readonly active: boolean;
  readonly mode: SessionMode;
  readonly levelId: string | null;
  readonly recallFirst: boolean;
  readonly slots: readonly SessionSlot[];
  readonly index: number;
  readonly startedAt: number;
  readonly paused: boolean;
  readonly finished: boolean;
  /** Question ids already granted a retry. A question comes back at most once. */
  readonly requeued: readonly QuestionId[];

  start(input: StartInput): void;
  revealOptions(): void;
  useHint(): void;
  /** Records the answer for the current slot. Never touches persistence. */
  submit(chosen: OptionKey, correct: boolean, now?: number): void;
  /** Appends a retry of the current question {@link REQUEUE_GAP} slots later. */
  requeueCurrent(): void;
  /** Moves to the next slot, or finishes the session when there is none. */
  advance(now?: number): void;
  pause(): void;
  resume(): void;
  /** Ends the session early (the user quit). Answered slots are kept. */
  finish(now?: number): void;
  reset(): void;
}

function freshSlot(questionId: QuestionId, revealed: boolean, requeue: boolean, startedAt: number): SessionSlot {
  return {
    questionId,
    hintsUsed: 0,
    optionsRevealed: revealed,
    chosen: null,
    answered: false,
    correct: false,
    startedAt,
    ms: 0,
    requeue,
  };
}

function mapSlot(
  slots: readonly SessionSlot[],
  index: number,
  fn: (slot: SessionSlot) => SessionSlot,
): readonly SessionSlot[] {
  return slots.map((slot, at) => (at === index ? fn(slot) : slot));
}

const IDLE = {
  active: false,
  mode: 'learn' as SessionMode,
  levelId: null,
  recallFirst: true,
  slots: [] as readonly SessionSlot[],
  index: 0,
  startedAt: 0,
  paused: false,
  finished: false,
  requeued: [] as readonly QuestionId[],
} as const;

export const useSessionStore = create<SessionSliceState>((set, get) => ({
  ...IDLE,

  start({ mode, levelId, questionIds, recallFirst, now }) {
    const slots = questionIds.map((id, at) =>
      freshSlot(id, !recallFirst, false, at === 0 ? now : 0),
    );
    set({
      active: true,
      mode,
      levelId,
      recallFirst,
      slots,
      index: 0,
      startedAt: now,
      paused: false,
      // An empty queue is finished the moment it starts; the runner shows the
      // "nothing to do" state rather than a blank question.
      finished: slots.length === 0,
      requeued: [],
    });
  },

  revealOptions() {
    const { slots, index } = get();
    set({ slots: mapSlot(slots, index, (slot) => ({ ...slot, optionsRevealed: true })) });
  },

  useHint() {
    const { slots, index } = get();
    const slot = slots[index];
    if (slot === undefined || slot.answered || slot.hintsUsed >= MAX_HINTS) return;
    // A hint is worthless against hidden options, so taking one reveals them.
    set({
      slots: mapSlot(slots, index, (s) => ({
        ...s,
        hintsUsed: s.hintsUsed + 1,
        optionsRevealed: true,
      })),
    });
  },

  submit(chosen, correct, now = Date.now()) {
    const { slots, index } = get();
    const slot = slots[index];
    // Guard against a double submit (fast double-tap, or keyboard + tap racing).
    if (slot === undefined || slot.answered) return;
    const startedAt = slot.startedAt > 0 ? slot.startedAt : now;
    set({
      slots: mapSlot(slots, index, (s) => ({
        ...s,
        chosen,
        correct,
        answered: true,
        optionsRevealed: true,
        ms: Math.max(0, now - startedAt),
      })),
    });
  },

  requeueCurrent() {
    const { slots, index, requeued, recallFirst } = get();
    const slot = slots[index];
    if (slot === undefined) return;
    if (requeued.includes(slot.questionId)) return;
    const at = Math.min(index + REQUEUE_GAP, slots.length);
    const next = [...slots];
    next.splice(at, 0, freshSlot(slot.questionId, !recallFirst, true, 0));
    set({ slots: next, requeued: [...requeued, slot.questionId] });
  },

  advance(now = Date.now()) {
    const { slots, index } = get();
    const nextIndex = index + 1;
    if (nextIndex >= slots.length) {
      set({ finished: true });
      return;
    }
    set({
      index: nextIndex,
      slots: mapSlot(slots, nextIndex, (slot) => ({
        ...slot,
        startedAt: slot.startedAt > 0 ? slot.startedAt : now,
      })),
    });
  },

  pause() {
    set({ paused: true });
  },

  resume() {
    set({ paused: false });
  },

  finish() {
    set({ finished: true, paused: false });
  },

  reset() {
    set({ ...IDLE });
  },
}));

/* ───────────────────────────── derived reads ────────────────────────────── */

export function currentSlot(state: SessionSliceState): SessionSlot | undefined {
  return state.slots[state.index];
}

/**
 * The answered slots as `AnswerRecord`s, in the order they were answered. This
 * is what goes into `SessionResult.answers`, so quitting halfway records exactly
 * the questions the user actually answered and nothing else.
 */
export function sessionAnswers(state: SessionSliceState): readonly AnswerRecord[] {
  const records: AnswerRecord[] = [];
  for (const slot of state.slots) {
    if (!slot.answered) continue;
    records.push({
      questionId: slot.questionId,
      chosen: slot.chosen,
      correct: slot.correct,
      hintsUsed: slot.hintsUsed,
      ms: slot.ms,
    });
  }
  return records;
}

export function correctCount(state: SessionSliceState): number {
  return state.slots.reduce((total, slot) => total + (slot.answered && slot.correct ? 1 : 0), 0);
}

export function answeredCount(state: SessionSliceState): number {
  return state.slots.reduce((total, slot) => total + (slot.answered ? 1 : 0), 0);
}

/** Consecutive correct answers at the end of the answered run — the `Streak` in the footer. */
export function currentStreak(state: SessionSliceState): number {
  let streak = 0;
  for (const slot of state.slots) {
    if (!slot.answered) continue;
    streak = slot.correct ? streak + 1 : 0;
  }
  return streak;
}

/** True when this question may still be sent to the back of the queue. */
export function canRequeue(state: SessionSliceState, questionId: QuestionId): boolean {
  return !state.requeued.includes(questionId);
}

/**
 * XP for a finished session: a clean correct answer is worth {@link XP_PER_CORRECT},
 * each hint taken on it shaves off {@link XP_HINT_PENALTY}, and a hinted-but-correct
 * answer is never worth zero. Wrong answers earn nothing — the streak and the
 * schedule are their own reward.
 */
export function xpFor(answers: readonly AnswerRecord[]): number {
  let xp = 0;
  for (const answer of answers) {
    if (!answer.correct) continue;
    xp += Math.max(1, XP_PER_CORRECT - answer.hintsUsed * XP_HINT_PENALTY);
  }
  return xp;
}

/* ─────────────────────────────── hooks ──────────────────────────────────── */

export const useCurrentSlot = (): SessionSlot | undefined => useSessionStore(currentSlot);
export const useSessionFinished = (): boolean => useSessionStore((s) => s.finished);
export const useSessionPaused = (): boolean => useSessionStore((s) => s.paused);
export const useSessionActive = (): boolean => useSessionStore((s) => s.active);
