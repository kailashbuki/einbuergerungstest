// `fake-indexeddb` is needed only by the `importProgress` round-trip at the
// bottom of this file; the merge itself is pure and touches no storage.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  MockResult,
  ProgressDoc,
  QuestionId,
  QuestionProgress,
  SessionResult,
  Settings,
  StateCode,
} from '@/types';
import { DB_VERSION, defaultProgressDoc, deleteDb, loadProgressDoc, replaceProgressDoc } from '@/lib/db';
import { defaultQuestionProgress, defaultSettings } from '@/lib/db/schema';
import { importProgress, serializeExport } from '@/lib/transfer';
import { mergeDocs, mergeQuestionProgress } from './merge';

/* ───────────────────────────── fixtures ─────────────────────────────── */

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

function qp(overrides: Partial<QuestionProgress> = {}): QuestionProgress {
  return { ...defaultQuestionProgress(T0), ...overrides };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(T0), state: 'BW', onboarded: true, ...overrides };
}

function session(id: string, finishedAt: number, overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    id,
    mode: 'learn',
    state: 'BW',
    startedAt: finishedAt - 60_000,
    finishedAt,
    answers: [{ questionId: 'F001', chosen: 'a', correct: true, hintsUsed: 0, ms: 900 }],
    correct: 1,
    total: 1,
    ...overrides,
  };
}

function mock(id: string, finishedAt: number, overrides: Partial<MockResult> = {}): MockResult {
  return {
    id,
    state: 'BW',
    startedAt: finishedAt - 600_000,
    finishedAt,
    durationMs: 600_000,
    answers: [{ questionId: 'F002', chosen: 'b', correct: false, hintsUsed: 0, ms: 4_000 }],
    correct: 28,
    total: 33,
    passed: true,
    ...overrides,
  };
}

function doc(overrides: Partial<ProgressDoc> = {}): ProgressDoc {
  return { ...defaultProgressDoc(DB_VERSION, T0), settings: settings(), ...overrides };
}

/** Deeply freeze a fixture so any attempt to mutate an input throws. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/* ══════════════════════════════════════════════════════════════════════
   1. two devices, disjoint question sets
   ═════════════════════════════════════════════════════════════════════ */

describe('two devices that studied disjoint question sets offline', () => {
  const deviceAProgress: Record<QuestionId, QuestionProgress> = {
    F001: qp({ seen: 3, correct: 3, wrong: 0, consecutiveCorrect: 3, lastSeen: T0 + 10, ease: 2.7, dueAt: T0 + 4 * DAY, updatedAt: T0 + 10 }),
    F002: qp({ seen: 2, correct: 1, wrong: 1, consecutiveCorrect: 1, hintsUsed: 1, lastSeen: T0 + 20, ease: 2.4, dueAt: T0 + DAY, updatedAt: T0 + 20 }),
    F003: qp({ seen: 1, correct: 0, wrong: 1, consecutiveCorrect: 0, lastSeen: T0 + 30, ease: 2.2, dueAt: T0 + 30, flagged: true, updatedAt: T0 + 30 }),
    F004: qp({ seen: 5, correct: 4, wrong: 1, consecutiveCorrect: 2, lastSeen: T0 + 40, note: 'Bundesrat!', updatedAt: T0 + 40 }),
    F005: qp({ seen: 1, correct: 1, wrong: 0, consecutiveCorrect: 1, lastSeen: T0 + 50, updatedAt: T0 + 50 }),
  };

  const deviceBProgress: Record<QuestionId, QuestionProgress> = {
    F006: qp({ seen: 4, correct: 2, wrong: 2, consecutiveCorrect: 0, lastSeen: T0 + 60, updatedAt: T0 + 60 }),
    F007: qp({ seen: 1, correct: 1, wrong: 0, consecutiveCorrect: 1, lastSeen: T0 + 70, updatedAt: T0 + 70 }),
    F008: qp({ seen: 2, correct: 2, wrong: 0, consecutiveCorrect: 2, hintsUsed: 2, lastSeen: T0 + 80, updatedAt: T0 + 80 }),
    F009: qp({ seen: 6, correct: 5, wrong: 1, consecutiveCorrect: 5, lastSeen: T0 + 90, ease: 2.9, dueAt: T0 + 9 * DAY, updatedAt: T0 + 90 }),
    F010: qp({ seen: 1, correct: 0, wrong: 1, consecutiveCorrect: 0, lastSeen: T0 + 100, updatedAt: T0 + 100 }),
    BW01: qp({ seen: 3, correct: 3, wrong: 0, consecutiveCorrect: 3, lastSeen: T0 + 110, note: 'Landeshauptstadt', updatedAt: T0 + 110 }),
    BW02: qp({ seen: 2, correct: 1, wrong: 1, consecutiveCorrect: 1, lastSeen: T0 + 120, flagged: true, updatedAt: T0 + 120 }),
    BW03: qp({ seen: 1, correct: 1, wrong: 0, consecutiveCorrect: 1, lastSeen: T0 + 130, updatedAt: T0 + 130 }),
  };

  const deviceA = deepFreeze(doc({ progress: deviceAProgress, xp: 50, updatedAt: T0 + 50 }));
  const deviceB = deepFreeze(doc({ progress: deviceBProgress, xp: 80, updatedAt: T0 + 130 }));

  it('keeps all 13 questions with their exact per-question values', () => {
    const merged = mergeDocs(deviceA, deviceB);

    // The full merged set, asserted as a whole — not just its size.
    expect(merged.progress).toEqual({ ...deviceAProgress, ...deviceBProgress });
    expect(Object.keys(merged.progress).sort()).toEqual([
      'BW01', 'BW02', 'BW03',
      'F001', 'F002', 'F003', 'F004', 'F005',
      'F006', 'F007', 'F008', 'F009', 'F010',
    ]);

    // A question present on only one side is kept verbatim.
    for (const [id, value] of Object.entries(deviceAProgress)) {
      expect(merged.progress[id]).toEqual(value);
    }
    for (const [id, value] of Object.entries(deviceBProgress)) {
      expect(merged.progress[id]).toEqual(value);
    }
  });

  it('merges the same way in the other direction and never mutates an input', () => {
    const beforeA = clone(deviceA);
    const beforeB = clone(deviceB);
    const merged = mergeDocs(deviceB, deviceA);

    expect(merged.progress).toEqual({ ...deviceAProgress, ...deviceBProgress });
    expect(deviceA).toEqual(beforeA);
    expect(deviceB).toEqual(beforeB);
  });

  it('does not invent, drop or blank any question', () => {
    const merged = mergeDocs(deviceA, deviceB);
    expect(Object.keys(merged.progress)).toHaveLength(13);
    for (const value of Object.values(merged.progress)) {
      expect(value.seen).toBeGreaterThan(0);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════
   2. two devices, the SAME question, different outcomes
   ═════════════════════════════════════════════════════════════════════ */

describe('two devices that studied the same question offline', () => {
  // Device A: answered it three times, ended on a 2-streak, wrote at T0+1000.
  const onA = qp({
    seen: 3,
    correct: 2,
    wrong: 1,
    consecutiveCorrect: 2,
    hintsUsed: 1,
    lastSeen: T0 + 1_000,
    ease: 2.7,
    dueAt: T0 + 6 * DAY,
    note: 'mnemonic from device A',
    updatedAt: T0 + 1_000,
  });
  // Device B: fewer reps but more wrongs and more hints, wrote *later*.
  const onB = qp({
    seen: 2,
    correct: 1,
    wrong: 2,
    consecutiveCorrect: 0,
    hintsUsed: 3,
    lastSeen: T0 + 2_000,
    ease: 2.1,
    dueAt: T0 + DAY,
    flagged: true,
    note: 'B',
    updatedAt: T0 + 2_000,
  });

  it('maxes every counter, so no studied answer is lost', () => {
    const merged = mergeQuestionProgress(onA, onB);
    expect(merged.seen).toBe(3);
    expect(merged.correct).toBe(2);
    expect(merged.wrong).toBe(2);
    expect(merged.hintsUsed).toBe(3);
    expect(merged.lastSeen).toBe(T0 + 2_000);
    expect(merged.updatedAt).toBe(T0 + 2_000);
  });

  it('keeps the better streak — neither side loses the streak it achieved', () => {
    expect(mergeQuestionProgress(onA, onB).consecutiveCorrect).toBe(2);
    expect(mergeQuestionProgress(onB, onA).consecutiveCorrect).toBe(2);
  });

  it('takes ease, dueAt and note from the side with the later updatedAt', () => {
    const merged = mergeQuestionProgress(onA, onB);
    expect(merged.ease).toBe(2.1);
    expect(merged.dueAt).toBe(T0 + DAY);
    expect(merged.note).toBe('B');
    // Symmetric: the *later* write wins regardless of argument order.
    const reversed = mergeQuestionProgress(onB, onA);
    expect(reversed.ease).toBe(2.1);
    expect(reversed.dueAt).toBe(T0 + DAY);
    expect(reversed.note).toBe('B');
  });

  it('never pushes a due question into the future', () => {
    // Maxing `dueAt` would hide a card that is due now; LWW must not do that.
    const merged = mergeQuestionProgress(onA, onB);
    expect(merged.dueAt).toBeLessThan(Math.max(onA.dueAt, onB.dueAt));
  });

  it('merges inside a whole document too', () => {
    const a = deepFreeze(doc({ progress: { F001: onA }, updatedAt: T0 + 1_000 }));
    const b = deepFreeze(doc({ progress: { F001: onB }, updatedAt: T0 + 2_000 }));
    expect(mergeDocs(a, b).progress['F001']).toEqual(mergeQuestionProgress(onA, onB));
    expect(mergeDocs(a, b).updatedAt).toBe(T0 + 2_000);
  });

  it('breaks an exact updatedAt tie deterministically and conservatively', () => {
    // Same millisecond, different scheduler state: prefer the values that mean
    // MORE review (earlier dueAt, lower ease) and the richer note.
    const left = qp({ ease: 2.8, dueAt: T0 + 9 * DAY, note: 'a long hand-written note', updatedAt: T0 + 5 });
    const right = qp({ ease: 2.0, dueAt: T0 + DAY, note: 'short', updatedAt: T0 + 5 });
    const forwards = mergeQuestionProgress(left, right);
    const backwards = mergeQuestionProgress(right, left);
    expect(forwards).toEqual(backwards);
    expect(forwards.ease).toBe(2.0);
    expect(forwards.dueAt).toBe(T0 + DAY);
    expect(forwards.note).toBe('a long hand-written note');
  });
});

/* ══════════════════════════════════════════════════════════════════════
   flags — the documented un-flagging rule
   ═════════════════════════════════════════════════════════════════════ */

describe('flag semantics', () => {
  it('keeps a flag raised concurrently (identical updatedAt)', () => {
    const flaggedSide = qp({ flagged: true, updatedAt: T0 + 100 });
    const plainSide = qp({ flagged: false, updatedAt: T0 + 100 });
    expect(mergeQuestionProgress(flaggedSide, plainSide).flagged).toBe(true);
    expect(mergeQuestionProgress(plainSide, flaggedSide).flagged).toBe(true);
  });

  it('propagates a flag raised later than the other side wrote', () => {
    const stale = qp({ flagged: false, updatedAt: T0 + 100 });
    const raised = qp({ flagged: true, updatedAt: T0 + 200 });
    expect(mergeQuestionProgress(stale, raised).flagged).toBe(true);
    expect(mergeQuestionProgress(raised, stale).flagged).toBe(true);
  });

  it('lets an un-flag win once it is the later write, so clearing converges', () => {
    const flaggedEarlier = qp({ flagged: true, updatedAt: T0 + 100 });
    const clearedLater = qp({ flagged: false, updatedAt: T0 + 200 });
    expect(mergeQuestionProgress(flaggedEarlier, clearedLater).flagged).toBe(false);
    expect(mergeQuestionProgress(clearedLater, flaggedEarlier).flagged).toBe(false);
    // ...and stays cleared when the merged copy syncs back again (convergence).
    const merged = mergeQuestionProgress(flaggedEarlier, clearedLater);
    expect(mergeQuestionProgress(merged, clearedLater).flagged).toBe(false);
    expect(mergeQuestionProgress(merged, merged).flagged).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   3. sessions and mocks from both devices all survive
   ═════════════════════════════════════════════════════════════════════ */

describe('session and mock history', () => {
  const shared = session('shared', T0 + 3_000);
  const a = doc({
    sessions: [session('a1', T0 + 1_000), shared, session('a2', T0 + 5_000)],
    mocks: [mock('m-a', T0 + 2_000)],
  });
  const b = doc({
    sessions: [session('b1', T0 + 2_000), clone(shared), session('b2', T0 + 4_000)],
    mocks: [mock('m-b', T0 + 6_000), mock('m-a', T0 + 2_000)],
  });

  it('unions by id with no duplicates when the same session syncs twice', () => {
    const merged = mergeDocs(deepFreeze(clone(a)), deepFreeze(clone(b)));
    expect(merged.sessions.map((s) => s.id)).toEqual(['a1', 'b1', 'shared', 'b2', 'a2']);
    expect(new Set(merged.sessions.map((s) => s.id)).size).toBe(merged.sessions.length);
    expect(merged.mocks.map((m) => m.id)).toEqual(['m-a', 'm-b']);
  });

  it('never truncates: every id from either side is present', () => {
    const merged = mergeDocs(a, b);
    for (const id of ['a1', 'a2', 'b1', 'b2', 'shared']) {
      expect(merged.sessions.some((s) => s.id === id)).toBe(true);
    }
    expect(merged.sessions).toHaveLength(5);
  });

  it('sorts deterministically by finishedAt then id, in both directions', () => {
    const forwards = mergeDocs(a, b);
    const backwards = mergeDocs(b, a);
    expect(forwards.sessions).toEqual(backwards.sessions);
    expect(forwards.mocks).toEqual(backwards.mocks);
  });

  it('uses id as a stable tie-break when finishedAt collides', () => {
    const left = doc({ sessions: [session('zz', T0), session('mm', T0)] });
    const right = doc({ sessions: [session('aa', T0)] });
    expect(mergeDocs(left, right).sessions.map((s) => s.id)).toEqual(['aa', 'mm', 'zz']);
    expect(mergeDocs(right, left).sessions.map((s) => s.id)).toEqual(['aa', 'mm', 'zz']);
  });

  it('prefers the richer copy when two records share an id but differ', () => {
    const rich = session('s1', T0 + 1_000, {
      answers: [
        { questionId: 'F001', chosen: 'a', correct: true, hintsUsed: 0, ms: 500 },
        { questionId: 'F002', chosen: 'b', correct: false, hintsUsed: 1, ms: 900 },
      ],
      total: 2,
    });
    const thin = session('s1', T0 + 1_000, { answers: [], total: 0, correct: 0 });
    const left = doc({ sessions: [rich] });
    const right = doc({ sessions: [thin] });
    expect(mergeDocs(left, right).sessions[0]).toEqual(rich);
    expect(mergeDocs(right, left).sessions[0]).toEqual(rich);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   4 + 5. order independence and idempotence on a rich fixture
   ═════════════════════════════════════════════════════════════════════ */

function richA(): ProgressDoc {
  return doc({
    schemaVersion: DB_VERSION,
    settings: settings({ uiLocale: 'tr', translation: 'tr', theme: 'dark', updatedAt: T0 + 400 }),
    progress: {
      F001: qp({ seen: 4, correct: 3, wrong: 1, consecutiveCorrect: 3, lastSeen: T0 + 10, ease: 2.6, dueAt: T0 + 3 * DAY, updatedAt: T0 + 10 }),
      F002: qp({ seen: 1, correct: 0, wrong: 1, flagged: true, lastSeen: T0 + 20, updatedAt: T0 + 20 }),
      BW01: qp({ seen: 7, correct: 7, consecutiveCorrect: 7, note: 'Stuttgart', lastSeen: T0 + 30, updatedAt: T0 + 30 }),
    },
    sessions: [session('s-a1', T0 + 900), session('s-both', T0 + 1_500)],
    mocks: [mock('m-a1', T0 + 1_100)],
    practiceDays: { '2026-01-01': true, '2026-01-02': true },
    badges: { 'first-session': T0 + 100, 'streak-3': T0 + 900 },
    xp: 420,
    updatedAt: T0 + 1_500,
  });
}

function richB(): ProgressDoc {
  return doc({
    schemaVersion: DB_VERSION,
    settings: settings({ uiLocale: 'en', translation: 'en', theme: 'light', updatedAt: T0 + 700 }),
    progress: {
      F001: qp({ seen: 2, correct: 2, wrong: 0, consecutiveCorrect: 2, lastSeen: T0 + 50, ease: 2.2, dueAt: T0 + DAY, note: 'from B', updatedAt: T0 + 50 }),
      F003: qp({ seen: 3, correct: 1, wrong: 2, hintsUsed: 4, lastSeen: T0 + 60, updatedAt: T0 + 60 }),
      BW02: qp({ seen: 1, correct: 1, consecutiveCorrect: 1, lastSeen: T0 + 70, updatedAt: T0 + 70 }),
    },
    sessions: [session('s-b1', T0 + 1_200), session('s-both', T0 + 1_500)],
    mocks: [mock('m-b1', T0 + 1_900, { passed: false, correct: 12 })],
    practiceDays: { '2026-01-02': true, '2026-01-03': true },
    badges: { 'first-session': T0 + 50, 'mock-passed': T0 + 1_900 },
    xp: 260,
    updatedAt: T0 + 1_900,
  });
}

describe('algebraic properties on a rich fixture', () => {
  it('is order independent: merge(a, b) deep-equals merge(b, a)', () => {
    const forwards = mergeDocs(deepFreeze(richA()), deepFreeze(richB()));
    const backwards = mergeDocs(deepFreeze(richB()), deepFreeze(richA()));
    expect(forwards).toEqual(backwards);
  });

  it('is idempotent: merging the result back in changes nothing', () => {
    const a = richA();
    const b = richB();
    const merged = mergeDocs(a, b);
    expect(mergeDocs(a, merged)).toEqual(merged);
    expect(mergeDocs(merged, a)).toEqual(merged);
    expect(mergeDocs(b, merged)).toEqual(merged);
    expect(mergeDocs(merged, b)).toEqual(merged);
    expect(mergeDocs(merged, merged)).toEqual(merged);
    // ...and a second full round changes nothing either.
    expect(mergeDocs(mergeDocs(a, merged), mergeDocs(b, merged))).toEqual(merged);
  });

  it('merging a document with itself is the identity', () => {
    const a = richA();
    expect(mergeDocs(a, a)).toEqual(a);
  });

  it('merging an empty document never loses anything', () => {
    const a = richA();
    const empty = defaultProgressDoc(DB_VERSION, 0);
    expect(mergeDocs(a, empty)).toEqual(a);
    expect(mergeDocs(empty, a)).toEqual(a);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   6. settings, and the null-state trap
   ═════════════════════════════════════════════════════════════════════ */

describe('settings', () => {
  it('takes the whole record from the side with the later updatedAt', () => {
    const older = settings({ uiLocale: 'de', translation: 'off', alwaysShowTranslation: false, updatedAt: T0 + 100 });
    const newer = settings({ uiLocale: 'ar', translation: 'ar', alwaysShowTranslation: true, updatedAt: T0 + 200 });
    const merged = mergeDocs(doc({ settings: older }), doc({ settings: newer })).settings;
    expect(merged).toEqual(newer);
    // No field-wise mixing: a combination the user never chose must not appear.
    expect(mergeDocs(doc({ settings: newer }), doc({ settings: older })).settings).toEqual(newer);
  });

  it('never lets a null state clobber a real one (incoming is newer)', () => {
    const onboarded = settings({ state: 'BY', onboarded: true, updatedAt: T0 + 100 });
    const fresh = settings({ state: null, onboarded: false, uiLocale: 'ru', updatedAt: T0 + 9_000 });
    const merged = mergeDocs(doc({ settings: onboarded }), doc({ settings: fresh })).settings;
    expect(merged.state).toBe('BY');
    expect(merged.onboarded).toBe(true);
    // Everything else still comes from the newer record.
    expect(merged.uiLocale).toBe('ru');
    expect(merged.updatedAt).toBe(T0 + 9_000);
  });

  it('never lets a null state clobber a real one (local is newer)', () => {
    const onboarded = settings({ state: 'HH', onboarded: true, updatedAt: T0 + 100 });
    const fresh = settings({ state: null, onboarded: false, uiLocale: 'uk', updatedAt: T0 + 9_000 });
    const merged = mergeDocs(doc({ settings: fresh }), doc({ settings: onboarded })).settings;
    expect(merged.state).toBe('HH');
    expect(merged.onboarded).toBe(true);
    expect(merged.uiLocale).toBe('uk');
  });

  it('keeps both devices out of the onboarding wizard after any merge order', () => {
    const onboarded = doc({ settings: settings({ state: 'SN', onboarded: true, updatedAt: T0 + 1 }) });
    const fresh = doc({ settings: settings({ state: null, onboarded: false, updatedAt: T0 + 2 }) });
    for (const merged of [mergeDocs(onboarded, fresh), mergeDocs(fresh, onboarded)]) {
      expect(merged.settings.state).not.toBeNull();
      expect(merged.settings.onboarded).toBe(true);
    }
  });

  it('keeps the winner state when both sides have a real (different) state', () => {
    const older = settings({ state: 'BW', updatedAt: T0 + 100 });
    const newer = settings({ state: 'NW', updatedAt: T0 + 200 });
    expect(mergeDocs(doc({ settings: older }), doc({ settings: newer })).settings.state).toBe('NW');
    expect(mergeDocs(doc({ settings: newer }), doc({ settings: older })).settings.state).toBe('NW');
  });

  it('resolves an exact settings updatedAt tie the same way in both directions', () => {
    const left = settings({ uiLocale: 'fr', theme: 'dark', updatedAt: T0 });
    const right = settings({ uiLocale: 'hi', theme: 'light', updatedAt: T0 });
    const forwards = mergeDocs(doc({ settings: left }), doc({ settings: right })).settings;
    const backwards = mergeDocs(doc({ settings: right }), doc({ settings: left })).settings;
    expect(forwards).toEqual(backwards);
    // Whichever wins, it is one coherent record, not a blend.
    expect([left.uiLocale, right.uiLocale]).toContain(forwards.uiLocale);
    expect(forwards.theme).toBe(forwards.uiLocale === left.uiLocale ? left.theme : right.theme);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   7. badges, xp, practice days, schema version
   ═════════════════════════════════════════════════════════════════════ */

describe('badges, xp and practice days', () => {
  it('keeps the earliest earn time for a badge held by both devices', () => {
    const a = doc({ badges: { 'streak-7': T0 + 5_000, 'solo-a': T0 + 1 } });
    const b = doc({ badges: { 'streak-7': T0 + 1_000, 'solo-b': T0 + 2 } });
    expect(mergeDocs(a, b).badges).toEqual({ 'streak-7': T0 + 1_000, 'solo-a': T0 + 1, 'solo-b': T0 + 2 });
    expect(mergeDocs(b, a).badges).toEqual({ 'streak-7': T0 + 1_000, 'solo-a': T0 + 1, 'solo-b': T0 + 2 });
  });

  it('takes the max xp rather than summing it (no double counting)', () => {
    const a = doc({ xp: 900 });
    const b = doc({ xp: 350 });
    expect(mergeDocs(a, b).xp).toBe(900);
    expect(mergeDocs(b, a).xp).toBe(900);
    // Syncing the same document twice must not inflate xp.
    expect(mergeDocs(a, mergeDocs(a, b)).xp).toBe(900);
  });

  it('unions practice days, so streaks survive a merge', () => {
    const a = doc({ practiceDays: { '2026-03-01': true, '2026-03-02': true } });
    const b = doc({ practiceDays: { '2026-03-02': true, '2026-03-03': true } });
    const expected = { '2026-03-01': true, '2026-03-02': true, '2026-03-03': true };
    expect(mergeDocs(a, b).practiceDays).toEqual(expected);
    expect(mergeDocs(b, a).practiceDays).toEqual(expected);
  });

  it('never downgrades the schema version', () => {
    const older = doc({ schemaVersion: 1 });
    const newer = doc({ schemaVersion: DB_VERSION + 3 });
    expect(mergeDocs(older, newer).schemaVersion).toBe(DB_VERSION + 3);
    expect(mergeDocs(newer, older).schemaVersion).toBe(DB_VERSION + 3);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   8. property / fuzz test with a seeded RNG
   ═════════════════════════════════════════════════════════════════════ */

/**
 * `mulberry32` — a tiny, fast, seeded PRNG. Deterministic on purpose: an
 * unseeded `Math.random()` would make a failure impossible to reproduce, and a
 * merge bug that only shows up in 1 run in 50 is exactly the kind of bug that
 * eats a user's progress.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const FUZZ_QUESTION_IDS: readonly QuestionId[] = [
  'F001', 'F002', 'F003', 'F004', 'F005', 'F006', 'BW01', 'BW02', 'BY01', 'HH01',
];
const FUZZ_SESSION_IDS: readonly string[] = ['s1', 's2', 's3', 's4', 's5'];
const FUZZ_MOCK_IDS: readonly string[] = ['m1', 'm2', 'm3'];
const FUZZ_DAYS: readonly string[] = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
const FUZZ_BADGES: readonly string[] = ['first-session', 'streak-3', 'streak-7', 'mock-passed'];
const FUZZ_STATES: readonly (StateCode | null)[] = ['BW', 'BY', 'HH', null];

function randomDoc(rand: () => number): ProgressDoc {
  const int = (max: number): number => Math.floor(rand() * max);
  const pick = <T,>(items: readonly T[]): T => {
    const item = items[int(items.length)];
    // `noUncheckedIndexedAccess`: `int(len)` is always in range, but prove it.
    if (item === undefined) throw new Error('empty pool');
    return item;
  };

  const progress: Record<QuestionId, QuestionProgress> = {};
  for (const id of FUZZ_QUESTION_IDS) {
    if (rand() < 0.4) continue;
    const seen = int(12);
    const correct = int(seen + 1);
    progress[id] = {
      seen,
      correct,
      wrong: Math.max(0, seen - correct),
      consecutiveCorrect: int(correct + 1),
      hintsUsed: int(5),
      lastSeen: T0 + int(10_000),
      ease: 1.3 + int(20) / 10,
      dueAt: T0 + int(30) * DAY,
      flagged: rand() < 0.3,
      note: rand() < 0.3 ? `note-${int(1_000)}` : '',
      // Ties are deliberately likely (a small clock space) so the tie-break
      // paths are exercised rather than being dead code in practice.
      updatedAt: T0 + int(20) * 100,
    };
  }

  const sessions: SessionResult[] = [];
  for (const id of FUZZ_SESSION_IDS) {
    if (rand() < 0.5) continue;
    sessions.push(session(id, T0 + int(10) * 1_000, { state: pick(['BW', 'BY', 'HH'] as const) }));
  }

  const mocks: MockResult[] = [];
  for (const id of FUZZ_MOCK_IDS) {
    if (rand() < 0.5) continue;
    mocks.push(mock(id, T0 + int(10) * 1_000, { passed: rand() < 0.5 }));
  }

  const practiceDays: Record<string, true> = {};
  for (const day of FUZZ_DAYS) if (rand() < 0.6) practiceDays[day] = true;

  const badges: Record<string, number> = {};
  for (const badge of FUZZ_BADGES) if (rand() < 0.6) badges[badge] = T0 + int(5_000);

  const state = pick(FUZZ_STATES);
  return {
    schemaVersion: 1 + int(3),
    settings: {
      ...defaultSettings(T0),
      state,
      onboarded: state !== null && rand() < 0.8,
      uiLocale: pick(['de', 'en', 'tr', 'ru'] as const),
      theme: pick(['light', 'dark', 'system'] as const),
      updatedAt: T0 + int(10) * 100,
    },
    progress,
    sessions,
    mocks,
    practiceDays,
    badges,
    xp: int(2_000),
    updatedAt: T0 + int(10_000),
  };
}

describe('property: randomised document pairs never lose progress', () => {
  const ITERATIONS = 200;

  it(`holds every invariant across ${ITERATIONS} seeded random pairs`, () => {
    const rand = mulberry32(0xc0ffee);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const a = randomDoc(rand);
      const b = randomDoc(rand);
      const beforeA = clone(a);
      const beforeB = clone(b);
      const merged = mergeDocs(a, b);

      // (a) No input is mutated.
      expect(a).toEqual(beforeA);
      expect(b).toEqual(beforeB);

      // (b) Every question id in either input is in the output, and every
      //     counter is >= both inputs.
      for (const [id, side] of [...Object.entries(a.progress), ...Object.entries(b.progress)]) {
        const out = merged.progress[id];
        expect(out, `question ${id} missing (iteration ${i})`).toBeDefined();
        if (out === undefined) continue;
        expect(out.seen).toBeGreaterThanOrEqual(side.seen);
        expect(out.correct).toBeGreaterThanOrEqual(side.correct);
        expect(out.wrong).toBeGreaterThanOrEqual(side.wrong);
        expect(out.hintsUsed).toBeGreaterThanOrEqual(side.hintsUsed);
        expect(out.consecutiveCorrect).toBeGreaterThanOrEqual(side.consecutiveCorrect);
        expect(out.lastSeen).toBeGreaterThanOrEqual(side.lastSeen);
        expect(out.updatedAt).toBeGreaterThanOrEqual(side.updatedAt);
        // States are never invented: they always come from one of the inputs.
        expect([a.progress[id]?.ease, b.progress[id]?.ease]).toContain(out.ease);
        expect([a.progress[id]?.dueAt, b.progress[id]?.dueAt]).toContain(out.dueAt);
        expect([a.progress[id]?.note, b.progress[id]?.note]).toContain(out.note);
      }
      expect(Object.keys(merged.progress).sort()).toEqual(
        [...new Set([...Object.keys(a.progress), ...Object.keys(b.progress)])].sort(),
      );

      // (c) Every session / mock id in either input is in the output, deduped
      //     and deterministically ordered.
      const sessionIds = new Set([...a.sessions, ...b.sessions].map((s) => s.id));
      expect(merged.sessions.map((s) => s.id).sort()).toEqual([...sessionIds].sort());
      expect(merged.sessions).toHaveLength(sessionIds.size);
      const mockIds = new Set([...a.mocks, ...b.mocks].map((m) => m.id));
      expect(merged.mocks.map((m) => m.id).sort()).toEqual([...mockIds].sort());
      expect(merged.mocks).toHaveLength(mockIds.size);
      for (let k = 1; k < merged.sessions.length; k += 1) {
        const prev = merged.sessions[k - 1];
        const cur = merged.sessions[k];
        if (prev === undefined || cur === undefined) continue;
        expect(prev.finishedAt).toBeLessThanOrEqual(cur.finishedAt);
      }

      // (d) Scalars never regress.
      expect(merged.xp).toBeGreaterThanOrEqual(Math.max(a.xp, b.xp));
      expect(merged.schemaVersion).toBe(Math.max(a.schemaVersion, b.schemaVersion));
      expect(merged.updatedAt).toBeGreaterThanOrEqual(Math.max(a.updatedAt, b.updatedAt));

      // (e) Day and badge keys are a union; badge times only move earlier.
      const days = new Set([...Object.keys(a.practiceDays), ...Object.keys(b.practiceDays)]);
      expect(Object.keys(merged.practiceDays).sort()).toEqual([...days].sort());
      const badgeIds = new Set([...Object.keys(a.badges), ...Object.keys(b.badges)]);
      expect(Object.keys(merged.badges).sort()).toEqual([...badgeIds].sort());
      for (const badge of badgeIds) {
        const earliest = Math.min(a.badges[badge] ?? Infinity, b.badges[badge] ?? Infinity);
        expect(merged.badges[badge]).toBe(earliest);
      }

      // (f) A real state is never replaced by null, and onboarding never undone.
      if (a.settings.state !== null || b.settings.state !== null) {
        expect(merged.settings.state).not.toBeNull();
      }
      if (a.settings.onboarded || b.settings.onboarded) {
        expect(merged.settings.onboarded).toBe(true);
      }

      // (g) Commutative and idempotent for this pair.
      expect(mergeDocs(b, a)).toEqual(merged);
      expect(mergeDocs(a, merged)).toEqual(merged);
      expect(mergeDocs(merged, b)).toEqual(merged);
      expect(mergeDocs(merged, merged)).toEqual(merged);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════
   9. end-to-end through the importProgress seam
   ═════════════════════════════════════════════════════════════════════ */

describe('the importProgress seam', () => {
  beforeEach(async () => {
    await deleteDb();
  });

  it('merges an export from another device into local storage without loss', async () => {
    // Local device: two federal questions, one session, 300 xp.
    const local = doc({
      settings: settings({ state: 'BW', onboarded: true, uiLocale: 'tr', updatedAt: T0 + 100 }),
      progress: {
        F001: qp({ seen: 4, correct: 4, consecutiveCorrect: 4, lastSeen: T0 + 10, updatedAt: T0 + 10 }),
        F002: qp({ seen: 1, correct: 0, wrong: 1, lastSeen: T0 + 20, updatedAt: T0 + 20 }),
      },
      sessions: [session('local-1', T0 + 500)],
      practiceDays: { '2026-02-01': true },
      badges: { 'first-session': T0 + 500 },
      xp: 300,
      updatedAt: T0 + 500,
    });
    await replaceProgressDoc(local, T0 + 500);

    // The other device's export: one overlapping and one new question, its own
    // session and mock, an extra practice day, a badge earned earlier.
    const incoming = doc({
      settings: settings({ state: null, onboarded: false, uiLocale: 'en', updatedAt: T0 + 90 }),
      progress: {
        F002: qp({ seen: 3, correct: 2, wrong: 1, consecutiveCorrect: 2, hintsUsed: 2, lastSeen: T0 + 80, ease: 2.1, dueAt: T0 + DAY, note: 'other device', updatedAt: T0 + 80 }),
        BW05: qp({ seen: 2, correct: 2, consecutiveCorrect: 2, lastSeen: T0 + 85, updatedAt: T0 + 85 }),
      },
      sessions: [session('remote-1', T0 + 700)],
      mocks: [mock('remote-mock', T0 + 800)],
      practiceDays: { '2026-02-02': true },
      badges: { 'first-session': T0 + 100 },
      xp: 220,
      updatedAt: T0 + 800,
    });

    const result = await importProgress(serializeExport(incoming, T0 + 900), mergeDocs, T0 + 1_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Nothing local was lost, everything incoming was gained.
    expect(Object.keys(result.doc.progress).sort()).toEqual(['BW05', 'F001', 'F002']);
    expect(result.doc.progress['F001']?.correct).toBe(4);
    expect(result.doc.progress['F002']?.seen).toBe(3);
    expect(result.doc.progress['F002']?.note).toBe('other device');
    expect(result.doc.sessions.map((s) => s.id)).toEqual(['local-1', 'remote-1']);
    expect(result.doc.mocks.map((m) => m.id)).toEqual(['remote-mock']);
    expect(result.doc.practiceDays).toEqual({ '2026-02-01': true, '2026-02-02': true });
    expect(result.doc.badges).toEqual({ 'first-session': T0 + 100 });
    expect(result.doc.xp).toBe(300);
    // The importing device must not be thrown back into onboarding.
    expect(result.doc.settings.state).toBe('BW');
    expect(result.doc.settings.onboarded).toBe(true);
    expect(result.doc.settings.uiLocale).toBe('tr');
    expect(result.summary.questionsAdded).toBe(1);
    expect(result.summary.sessionsAdded).toBe(1);
    expect(result.summary.mocksAdded).toBe(1);

    // And the merge was actually persisted.
    const reloaded = await loadProgressDoc();
    expect(Object.keys(reloaded.progress).sort()).toEqual(['BW05', 'F001', 'F002']);
    expect(reloaded.sessions.map((s) => s.id)).toEqual(['local-1', 'remote-1']);
    expect(reloaded.xp).toBe(300);
  });

  it('is safe to import the same file twice (idempotent through the seam)', async () => {
    const incoming = doc({
      progress: { F009: qp({ seen: 2, correct: 1, wrong: 1, lastSeen: T0 + 5, updatedAt: T0 + 5 }) },
      sessions: [session('dup', T0 + 5)],
      xp: 40,
      updatedAt: T0 + 5,
    });
    const text = serializeExport(incoming, T0 + 10);

    const first = await importProgress(text, mergeDocs, T0 + 20);
    const second = await importProgress(text, mergeDocs, T0 + 30);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.doc.sessions).toHaveLength(1);
    expect(second.doc.progress['F009']?.seen).toBe(2);
    expect(second.doc.xp).toBe(40);
    expect(second.doc.progress).toEqual(first.doc.progress);
  });
});
