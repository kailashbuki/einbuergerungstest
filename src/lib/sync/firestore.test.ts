/**
 * What is and is not covered here.
 *
 * There is no Firebase project and no network in this environment, so the tests
 * below cover the two things that *are* genuinely testable — and they are also
 * the two that matter most today:
 *
 * 1. **The unconfigured path**, which is what a fork with no Firebase project of
 *    its own hits (`src/lib/firebase.ts` holding `TODO(user)` placeholders).
 *    Every method must degrade to no-op behaviour without throwing or hanging.
 *    `@/lib/firebase` is mocked as unconfigured below so these cases test that
 *    branch regardless of what config this checkout happens to ship — they must
 *    not start failing the day someone fills in a real project.
 * 2. **The runtime validator** for documents read back from Firestore, which is
 *    pure logic and the last line of defence against a malformed remote
 *    document being merged into a user's progress.
 * 3. **The pure decision points that can destroy data**: `applyMutations` (what
 *    a push will write), `assertRemoteWritable` (when a push must refuse) and the
 *    remote-reset path (which must overwrite, never merge).
 *
 * Deliberately **not** tested (needs a live project or the emulator): the Google
 * popup sign-in flow, `getDoc`/`onSnapshot` wiring, the `runTransaction` retry
 * behaviour, and the `setDoc` call inside `resetRemote`. Those are asserted by
 * inspection only, and are called out as untested in the workstream report rather
 * than faked with mocks that would prove nothing about Firestore's real
 * behaviour.
 */

import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { Mutation, ProgressDoc, QuestionProgress, SyncAdapter } from '@/types';
import { isFirebaseConfigured } from '@/lib/firebase';
import { DB_VERSION } from '@/lib/db/migrations';
import { loadProgressDoc, replaceProgressDoc } from '@/lib/db';
import { defaultProgressDoc, defaultQuestionProgress, defaultSettings } from '@/lib/db/schema';
import { isSyncAdapter, SYNC_ADAPTER_METHODS } from './SyncAdapter';
import { createNoopSyncAdapter, noopSyncAdapter } from './noop';
import { mergeDocs } from './merge';
import {
  applyMutations,
  assertRemoteWritable,
  createFirestoreAdapter,
  FIRESTORE_ADAPTER_NAME,
  isSyncError,
  MAX_REMOTE_DOC_BYTES,
  MIN_REMOTE_SCHEMA_VERSION,
  overlayFromMutations,
  parseRemoteProgressDoc,
  RESET_TIMEOUT_MS,
  resetRemotePayload,
  resetRemoteProgress,
  supportsRemoteReset,
  SyncError,
  toRemoteData,
  USERS_COLLECTION,
  userDocPath,
  type RemoteResettable,
} from './firestore';

/**
 * Force the unconfigured branch. `createFirestoreAdapter` samples
 * `isFirebaseConfigured()` at construction, so this one mock drives every
 * degrade-gracefully case below, and `getFirebase` resolving `null` matches what
 * the real module does when the config is a placeholder.
 *
 * Without this, these tests assert a property of *this checkout's config file*
 * rather than of the adapter, and break as soon as sync is configured for real.
 */
vi.mock('@/lib/firebase', () => ({
  isFirebaseConfigured: (): boolean => false,
  getFirebase: (): Promise<null> => Promise.resolve(null),
}));

const T0 = 1_700_000_000_000;

const mutations: readonly Mutation[] = [
  { kind: 'xp', id: 'm1', at: T0, value: 120 },
  {
    kind: 'progress',
    id: 'm2',
    at: T0 + 1,
    questionId: 'F001',
    value: { ...defaultQuestionProgress(T0), seen: 2, correct: 2 },
  },
  { kind: 'practiceDay', id: 'm3', at: T0 + 2, day: '2026-05-01' },
];

function validDoc(overrides: Partial<ProgressDoc> = {}): ProgressDoc {
  const base = defaultProgressDoc(DB_VERSION, T0);
  return {
    ...base,
    settings: { ...defaultSettings(T0), state: 'BW', onboarded: true },
    progress: { F001: { ...defaultQuestionProgress(T0), seen: 3, correct: 2, wrong: 1 } },
    sessions: [
      {
        id: 's1',
        mode: 'learn',
        state: 'BW',
        startedAt: T0,
        finishedAt: T0 + 1_000,
        answers: [{ questionId: 'F001', chosen: 'a', correct: true, hintsUsed: 0, ms: 700 }],
        correct: 1,
        total: 1,
      },
    ],
    mocks: [],
    practiceDays: { '2026-04-01': true },
    badges: { 'first-session': T0 },
    xp: 200,
    updatedAt: T0 + 1_000,
    ...overrides,
  };
}

/** What Firestore would hand back: plain JSON, no class instances. */
function asRemote(doc: ProgressDoc): object {
  const plain: unknown = JSON.parse(JSON.stringify(doc));
  if (plain === null || typeof plain !== 'object') throw new Error('fixture is not an object');
  return plain;
}

/* ══════════════════════════════════════════════════════════════════════
   the checked-in config itself
   ═════════════════════════════════════════════════════════════════════ */

describe('the real (unmocked) Firebase config', () => {
  it('is all-or-nothing: no half-filled config that silently disables sync', async () => {
    const actual = await vi.importActual<typeof import('@/lib/firebase')>('@/lib/firebase');
    const values = Object.values(actual.firebaseConfig);
    expect(values).toHaveLength(6);
    const filled = values.filter((value) => value !== 'TODO(user)' && value.trim() !== '');
    // Either every field is a placeholder or every field is real. A partial edit
    // leaves `isFirebaseConfigured()` false with no visible reason why.
    expect([0, 6]).toContain(filled.length);
    expect(actual.isFirebaseConfigured()).toBe(filled.length === 6);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   the unconfigured path — what a fork without a Firebase project hits
   ═════════════════════════════════════════════════════════════════════ */

describe('the Firestore adapter with Firebase unconfigured', () => {
  it('starts from the premise that Firebase is unconfigured', () => {
    // Guards the mock, not the checked-in config: if this fails, the mock above
    // stopped taking effect and the rest of this block is testing nothing.
    expect(isFirebaseConfigured()).toBe(false);
  });

  it('satisfies the full SyncAdapter contract', () => {
    const adapter = createFirestoreAdapter();
    expect(isSyncAdapter(adapter)).toBe(true);
    for (const method of SYNC_ADAPTER_METHODS) {
      expect(typeof adapter[method]).toBe('function');
    }
    expect(adapter.name).toBe(FIRESTORE_ADAPTER_NAME);
    expect(adapter.name).toBe('firestore');
  });

  it('reports configured === false so the UI can hide sign-in', () => {
    expect(createFirestoreAdapter().configured).toBe(false);
  });

  it('reports signed-out rather than an error, with no account', () => {
    const adapter = createFirestoreAdapter();
    expect(adapter.status()).toBe('signed-out');
    expect(adapter.account()).toBeNull();
  });

  it('resolves signIn and signOut silently, repeatedly, without throwing', async () => {
    const adapter = createFirestoreAdapter();
    await expect(adapter.signIn()).resolves.toBeUndefined();
    await expect(adapter.signOut()).resolves.toBeUndefined();
    await expect(adapter.signIn()).resolves.toBeUndefined();
    await expect(adapter.signIn()).resolves.toBeUndefined();
    // Still nothing happened.
    expect(adapter.status()).toBe('signed-out');
    expect(adapter.account()).toBeNull();
  });

  it('pulls null', async () => {
    await expect(createFirestoreAdapter().pull()).resolves.toBeNull();
    // Repeat pulls stay cheap and silent.
    const adapter = createFirestoreAdapter();
    expect(await adapter.pull()).toBeNull();
    expect(await adapter.pull()).toBeNull();
    expect(adapter.status()).toBe('signed-out');
  });

  it('accepts and discards pushes, including the empty no-op', async () => {
    const adapter = createFirestoreAdapter();
    await expect(adapter.push([])).resolves.toBeUndefined();
    await expect(adapter.push(mutations)).resolves.toBeUndefined();
    await expect(adapter.push([...mutations, ...mutations])).resolves.toBeUndefined();
    expect(adapter.status()).toBe('signed-out');
  });

  it('returns a working unsubscribe whose callback never fires', async () => {
    const adapter = createFirestoreAdapter();
    let calls = 0;
    const unsubscribe = adapter.subscribe(() => {
      calls += 1;
    });
    expect(typeof unsubscribe).toBe('function');
    // Give any (non-existent) async attachment a chance to run.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(0);
    // Idempotent.
    expect(() => {
      unsubscribe();
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
    expect(calls).toBe(0);
  });

  it('never blocks: a full unconfigured cycle settles promptly', async () => {
    const adapter = createFirestoreAdapter();
    const cycle = (async (): Promise<string> => {
      await adapter.signIn();
      await adapter.pull();
      await adapter.push(mutations);
      adapter.subscribe(() => {})();
      await adapter.signOut();
      return 'done';
    })();
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 1_000));
    await expect(Promise.race([cycle, timeout])).resolves.toBe('done');
  });

  it('keeps instances independent', async () => {
    const a = createFirestoreAdapter();
    const b = createFirestoreAdapter();
    await a.signIn();
    expect(b.status()).toBe('signed-out');
    expect(b.account()).toBeNull();
  });

  it('exposes the document layout it shares with firestore.rules', () => {
    expect(USERS_COLLECTION).toBe('users');
    expect(userDocPath('abc123')).toBe('users/abc123');
  });
});

/* ══════════════════════════════════════════════════════════════════════
   bundle-size guard: firebase must stay lazily imported
   ═════════════════════════════════════════════════════════════════════ */

describe('lazy firebase imports', () => {
  it('has no top-level value import from firebase/*', () => {
    // Vitest runs with the repo root as cwd; `import.meta.url` is not a file URL
    // once Vite has transformed this module.
    const source = readFileSync(join(process.cwd(), 'src/lib/sync/firestore.ts'), 'utf8');
    const staticImports = source
      .split('\n')
      .filter((line) => /^import\s/.test(line) || /^\s*}\s*from\s+'firebase\//.test(line))
      .filter((line) => line.includes("'firebase/"));
    // Every static mention must be an erased type-only import; the real ones
    // live behind `await import(...)` / `getFirebase()`.
    for (const line of staticImports) {
      expect(line.startsWith('import type ')).toBe(true);
    }
    // And the lazy imports really are there.
    expect(source).toContain("await import('firebase/auth')");
    expect(source).toContain("await import('firebase/firestore')");
  });
});

/* ══════════════════════════════════════════════════════════════════════
   the runtime validator
   ═════════════════════════════════════════════════════════════════════ */

describe('parseRemoteProgressDoc', () => {
  it('accepts a well-formed document and preserves every field', () => {
    const doc = validDoc();
    const parsed = parseRemoteProgressDoc(asRemote(doc));
    expect(parsed).toEqual(doc);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', '{"progress":{}}'],
    ['a boolean', true],
    ['an array', [validDoc()]],
    ['an empty array', []],
    ['an empty object', {}],
  ])('rejects %s', (_label, value) => {
    expect(parseRemoteProgressDoc(value)).toBeNull();
  });

  it.each(['settings', 'progress', 'sessions', 'mocks', 'practiceDays', 'badges', 'schemaVersion'])(
    'rejects a document missing %s',
    (field) => {
      const copy: Record<string, unknown> = { ...asRemote(validDoc()) };
      expect(copy[field]).toBeDefined();
      delete copy[field];
      expect(parseRemoteProgressDoc(copy)).toBeNull();
    },
  );

  it.each([
    ['settings as an array', { settings: [] }],
    ['settings as a string', { settings: 'BW' }],
    ['progress as an array', { progress: [] }],
    ['progress as null', { progress: null }],
    ['sessions as an object', { sessions: {} }],
    ['sessions as a string', { sessions: 'none' }],
    ['mocks as a number', { mocks: 0 }],
    ['practiceDays as an array', { practiceDays: ['2026-01-01'] }],
    ['badges as an array', { badges: [T0] }],
  ])('rejects %s', (_label, patch) => {
    expect(parseRemoteProgressDoc({ ...validDoc(), ...patch })).toBeNull();
  });

  it.each([
    ['0', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '3'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
  ])('rejects schemaVersion %s', (_label, schemaVersion) => {
    expect(parseRemoteProgressDoc({ ...validDoc(), schemaVersion })).toBeNull();
  });

  it('accepts the oldest supported schema version', () => {
    const parsed = parseRemoteProgressDoc({ ...validDoc(), schemaVersion: MIN_REMOTE_SCHEMA_VERSION });
    expect(parsed?.schemaVersion).toBe(MIN_REMOTE_SCHEMA_VERSION);
  });

  it('backfills the spaced-repetition fields a v1 document lacks', () => {
    // v1 progress records had counters and a note, but no ease/dueAt/flagged.
    const parsed = parseRemoteProgressDoc({
      ...validDoc(),
      schemaVersion: 1,
      progress: { F001: { seen: 2, correct: 1, wrong: 1, lastSeen: T0, note: 'keep me' } },
    });
    const entry = parsed?.progress['F001'];
    expect(entry).toBeDefined();
    expect(entry?.seen).toBe(2);
    expect(entry?.note).toBe('keep me');
    expect(entry?.ease).toBeGreaterThan(0);
    // `dueAt` falls back to `lastSeen`, so an old question surfaces immediately
    // rather than never.
    expect(entry?.dueAt).toBe(T0);
    expect(entry?.flagged).toBe(false);
  });

  it('still reads a document from a newer build (push refuses to write it)', () => {
    const parsed = parseRemoteProgressDoc({
      ...asRemote(validDoc()),
      schemaVersion: DB_VERSION + 5,
      somethingNew: { added: 'by a future version' },
    });
    expect(parsed?.schemaVersion).toBe(DB_VERSION + 5);
    expect(parsed?.progress['F001']?.seen).toBe(3);
  });

  it('tolerates a missing or nonsensical xp and updatedAt by defaulting to 0', () => {
    const raw: Record<string, unknown> = { ...validDoc() };
    delete raw['xp'];
    raw['updatedAt'] = 'yesterday';
    const parsed = parseRemoteProgressDoc(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.xp).toBe(0);
    expect(parsed?.updatedAt).toBe(0);
  });

  it('drops individual corrupt entries instead of failing the whole document', () => {
    const parsed = parseRemoteProgressDoc({
      ...validDoc(),
      progress: { F001: { seen: 1, correct: 1, lastSeen: T0, updatedAt: T0 }, F002: 'corrupt', F003: null },
      sessions: ['not a session', { id: '', answers: [] }, { id: 'ok', finishedAt: T0, answers: [] }],
      mocks: [7, { id: 'mock-ok', finishedAt: T0, answers: [] }],
      practiceDays: { '2026-01-01': true, '2026-01-02': false, '': true },
      badges: { good: T0, bad: 'soon', negative: -5 },
    });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed?.progress ?? {})).toEqual(['F001']);
    expect(parsed?.sessions.map((s) => s.id)).toEqual(['ok']);
    expect(parsed?.mocks.map((m) => m.id)).toEqual(['mock-ok']);
    expect(parsed?.practiceDays).toEqual({ '2026-01-01': true });
    expect(parsed?.badges).toEqual({ good: T0 });
  });

  it('never returns a document with a state it cannot understand', () => {
    const parsed = parseRemoteProgressDoc({
      ...validDoc(),
      settings: { ...defaultSettings(T0), state: 'XX', uiLocale: 'klingon', theme: 'neon' },
    });
    expect(parsed).not.toBeNull();
    // Unknown values fall back to defaults rather than leaking into the app.
    expect(parsed?.settings.state).toBeNull();
    expect(parsed?.settings.uiLocale).toBe('de');
    expect(parsed?.settings.theme).toBe('system');
  });

  it('keeps a document-size ceiling below the Firestore 1 MiB limit', () => {
    expect(MAX_REMOTE_DOC_BYTES).toBeLessThan(1_048_576);
    expect(JSON.stringify(validDoc()).length).toBeLessThan(MAX_REMOTE_DOC_BYTES);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   the pure core of push: outbox → remote document
   ═════════════════════════════════════════════════════════════════════ */

function progressMutation(
  id: string,
  at: number,
  questionId: string,
  value: Partial<QuestionProgress>,
): Mutation {
  return {
    kind: 'progress',
    id,
    at,
    questionId,
    value: { ...defaultQuestionProgress(at), updatedAt: at, ...value },
  };
}

function sessionMutation(id: string, at: number, sessionId: string): Mutation {
  return {
    kind: 'session',
    id,
    at,
    value: {
      id: sessionId,
      mode: 'drill',
      state: 'BW',
      startedAt: at - 1_000,
      finishedAt: at,
      answers: [],
      correct: 0,
      total: 0,
    },
  };
}

describe('overlayFromMutations', () => {
  it('folds an empty outbox into an empty overlay', () => {
    const overlay = overlayFromMutations([]);
    expect(overlay.hasSettings).toBe(false);
    expect(overlay.doc.progress).toEqual({});
    expect(overlay.doc.sessions).toEqual([]);
    expect(overlay.doc.mocks).toEqual([]);
    expect(overlay.doc.xp).toBe(0);
    expect(overlay.doc.updatedAt).toBe(0);
    // The placeholder settings record must lose every merge it takes part in.
    expect(overlay.doc.settings.updatedAt).toBe(0);
  });

  it('collapses several writes to one question with the merge rules', () => {
    const overlay = overlayFromMutations([
      progressMutation('a', T0 + 10, 'F001', { seen: 3, correct: 3, consecutiveCorrect: 3 }),
      progressMutation('b', T0 + 20, 'F001', { seen: 1, correct: 0, wrong: 1, hintsUsed: 2 }),
    ]);
    const entry = overlay.doc.progress['F001'];
    expect(entry?.seen).toBe(3);
    expect(entry?.correct).toBe(3);
    expect(entry?.wrong).toBe(1);
    expect(entry?.hintsUsed).toBe(2);
    expect(entry?.consecutiveCorrect).toBe(3);
    expect(entry?.updatedAt).toBe(T0 + 20);
  });

  it('de-duplicates a session queued twice, so nothing is double-counted', () => {
    const overlay = overlayFromMutations([
      sessionMutation('m1', T0 + 1, 's-dup'),
      sessionMutation('m2', T0 + 2, 's-dup'),
      sessionMutation('m3', T0 + 3, 's-other'),
    ]);
    expect(overlay.doc.sessions.map((s) => s.id)).toEqual(['s-dup', 's-other']);
  });

  it('treats xp as an absolute total and badges as earliest-earned', () => {
    const overlay = overlayFromMutations([
      { kind: 'xp', id: 'x1', at: T0 + 1, value: 120 },
      { kind: 'xp', id: 'x2', at: T0 + 2, value: 80 },
      { kind: 'badge', id: 'b1', at: T0 + 3, badge: 'streak-7', earnedAt: T0 + 500 },
      { kind: 'badge', id: 'b2', at: T0 + 4, badge: 'streak-7', earnedAt: T0 + 100 },
      { kind: 'practiceDay', id: 'd1', at: T0 + 5, day: '2026-06-01' },
      { kind: 'practiceDay', id: 'd2', at: T0 + 6, day: '2026-06-02' },
    ]);
    expect(overlay.doc.xp).toBe(120);
    expect(overlay.doc.badges).toEqual({ 'streak-7': T0 + 100 });
    expect(overlay.doc.practiceDays).toEqual({ '2026-06-01': true, '2026-06-02': true });
    expect(overlay.doc.updatedAt).toBe(T0 + 6);
  });

  it('takes the most recently stamped settings record as one unit', () => {
    const older = { ...defaultSettings(T0 + 100), state: 'BW' as const, uiLocale: 'tr' as const };
    const newer = { ...defaultSettings(T0 + 200), state: 'BY' as const, uiLocale: 'en' as const };
    const overlay = overlayFromMutations([
      { kind: 'settings', id: 's1', at: T0 + 1, value: older },
      { kind: 'settings', id: 's2', at: T0 + 2, value: newer },
    ]);
    expect(overlay.hasSettings).toBe(true);
    expect(overlay.doc.settings).toEqual(newer);
  });
});

describe('applyMutations (the read-merge-write body)', () => {
  const remote = validDoc({
    progress: {
      F001: { ...defaultQuestionProgress(T0), seen: 9, correct: 9, consecutiveCorrect: 9, updatedAt: T0 },
      F050: { ...defaultQuestionProgress(T0), seen: 4, correct: 3, wrong: 1, updatedAt: T0 },
    },
    xp: 500,
    badges: { 'first-session': T0 + 10 },
    practiceDays: { '2026-04-01': true },
  });

  it('writes the overlay verbatim when there is no remote document yet', () => {
    const next = applyMutations(null, [progressMutation('a', T0 + 10, 'F001', { seen: 1 })]);
    expect(Object.keys(next.progress)).toEqual(['F001']);
    expect(next.schemaVersion).toBe(DB_VERSION);
  });

  it('never clobbers progress another device already pushed', () => {
    const next = applyMutations(remote, [
      progressMutation('a', T0 + 10, 'F002', { seen: 2, correct: 2 }),
      { kind: 'xp', id: 'x', at: T0 + 11, value: 120 },
    ]);
    // Remote-only questions survive untouched...
    expect(next.progress['F001']).toEqual(remote.progress['F001']);
    expect(next.progress['F050']).toEqual(remote.progress['F050']);
    // ...the new one is added...
    expect(next.progress['F002']?.seen).toBe(2);
    // ...and a stale local xp total never lowers the remote one.
    expect(next.xp).toBe(500);
    expect(next.badges).toEqual(remote.badges);
    expect(next.practiceDays).toEqual(remote.practiceDays);
    expect(next.sessions).toEqual(remote.sessions);
  });

  it('maxes counters when both devices studied the same question', () => {
    const next = applyMutations(remote, [
      progressMutation('a', T0 + 10, 'F001', { seen: 2, correct: 1, wrong: 1, hintsUsed: 3 }),
    ]);
    expect(next.progress['F001']?.seen).toBe(9);
    expect(next.progress['F001']?.correct).toBe(9);
    expect(next.progress['F001']?.wrong).toBe(1);
    expect(next.progress['F001']?.hintsUsed).toBe(3);
    expect(next.progress['F001']?.consecutiveCorrect).toBe(9);
  });

  it('leaves remote settings completely untouched when no settings mutation is queued', () => {
    const next = applyMutations(remote, [progressMutation('a', T0 + 10, 'F002', { seen: 1 })]);
    expect(next.settings).toEqual(remote.settings);
  });

  it('applies a newer settings record as one unit', () => {
    const chosen = {
      ...defaultSettings(T0 + 9_000),
      state: 'HH' as const,
      uiLocale: 'ru' as const,
      // `onboarded` is monotonic in the merge (it can never un-happen), so the
      // fixture carries the remote's `true` rather than expecting it to reset.
      onboarded: true,
    };
    const next = applyMutations(remote, [{ kind: 'settings', id: 's', at: T0 + 9_000, value: chosen }]);
    expect(next.settings).toEqual(chosen);
  });

  it('does not let a stale local settings record beat the remote one', () => {
    const stale = { ...defaultSettings(T0 - 1_000), state: 'SN' as const, uiLocale: 'fr' as const };
    const next = applyMutations(remote, [{ kind: 'settings', id: 's', at: T0, value: stale }]);
    expect(next.settings).toEqual(remote.settings);
  });

  it('does not let a null state from a reset device undo onboarding remotely', () => {
    const wiped = { ...defaultSettings(T0 + 9_000), state: null, onboarded: false };
    const next = applyMutations(remote, [{ kind: 'settings', id: 's', at: T0 + 9_000, value: wiped }]);
    expect(next.settings.state).toBe(remote.settings.state);
    expect(next.settings.onboarded).toBe(true);
  });

  it('is idempotent: re-pushing the same outbox changes nothing', () => {
    const queue: readonly Mutation[] = [
      progressMutation('a', T0 + 10, 'F002', { seen: 2, correct: 2 }),
      sessionMutation('b', T0 + 11, 's-new'),
      { kind: 'xp', id: 'c', at: T0 + 12, value: 900 },
      { kind: 'badge', id: 'd', at: T0 + 13, badge: 'streak-7', earnedAt: T0 + 50 },
    ];
    const once = applyMutations(remote, queue);
    const twice = applyMutations(once, queue);
    expect(twice).toEqual(once);
    // ...and the second application did not duplicate the session or inflate xp.
    expect(twice.sessions.filter((s) => s.id === 's-new')).toHaveLength(1);
    expect(twice.xp).toBe(900);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   typed errors — the UI has exactly one type to catch
   ═════════════════════════════════════════════════════════════════════ */

describe('SyncError', () => {
  it('is a real Error, carries a machine-readable code, and keeps the cause', () => {
    const cause = new Error('permission-denied');
    const error = new SyncError('reset-failed', 'could not erase the cloud copy', { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SyncError);
    expect(error.name).toBe('SyncError');
    expect(error.code).toBe('reset-failed');
    expect(error.message).toContain('could not erase the cloud copy');
    expect(error.cause).toBe(cause);
  });

  it('narrows only real SyncErrors', () => {
    expect(isSyncError(new SyncError('signed-out', 'x'))).toBe(true);
    expect(isSyncError(new Error('x'))).toBe(false);
    expect(isSyncError('signed-out')).toBe(false);
    expect(isSyncError(null)).toBe(false);
    expect(isSyncError(undefined)).toBe(false);
    expect(isSyncError({ code: 'signed-out' })).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   assertRemoteWritable — the two refusals that protect the cloud copy
   ═════════════════════════════════════════════════════════════════════ */

describe('assertRemoteWritable', () => {
  it('allows the very first write, when no document exists yet', () => {
    expect(() => {
      assertRemoteWritable(null, false);
    }).not.toThrow();
  });

  it('allows a readable document written by this build', () => {
    expect(() => {
      assertRemoteWritable(validDoc(), true);
    }).not.toThrow();
  });

  it('allows an older schema: coercion backfills what it lacks', () => {
    expect(() => {
      assertRemoteWritable(validDoc({ schemaVersion: MIN_REMOTE_SCHEMA_VERSION }), true);
    }).not.toThrow();
  });

  it('refuses to overwrite a document it could not read, loudly', () => {
    // A document exists but failed validation. Overwriting could destroy the
    // user's only copy, so the push must stall — and the user must be told.
    try {
      assertRemoteWritable(null, true);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isSyncError(error)).toBe(true);
      expect(isSyncError(error) ? error.code : '').toBe('remote-unreadable');
    }
  });

  it('refuses to downgrade a newer document, and says to update the app', () => {
    // Silently not syncing is the worst failure mode: the user would believe
    // their progress is backed up when it is not. So this is a typed, surfaced
    // error rather than a swallowed one.
    try {
      assertRemoteWritable(validDoc({ schemaVersion: DB_VERSION + 1 }), true);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isSyncError(error)).toBe(true);
      expect(isSyncError(error) ? error.code : '').toBe('remote-newer');
      // The message has to be actionable for a non-technical user.
      expect(isSyncError(error) ? error.message : '').toContain('Update the app');
    }
  });

  it('is wired into push, which re-throws rather than swallowing', () => {
    // Source guard: the transaction body cannot be executed without a live
    // project, so assert the refusal is actually consulted there and that push
    // propagates instead of resolving.
    const source = readFileSync(join(process.cwd(), 'src/lib/sync/firestore.ts'), 'utf8');
    expect(source).toContain('assertRemoteWritable(remote, existed)');
    const pushBody = source.slice(source.indexOf('async push('), source.indexOf('async resetRemote('));
    expect(pushBody).toContain('throw error instanceof Error');
  });
});

/* ══════════════════════════════════════════════════════════════════════
   the size ceiling
   ═════════════════════════════════════════════════════════════════════ */

describe('toRemoteData', () => {
  it('produces plain JSON data equal to the document', () => {
    expect(toRemoteData(validDoc())).toEqual(asRemote(validDoc()));
  });

  it('refuses an oversized document with a typed error instead of truncating', () => {
    const huge = validDoc({
      progress: {
        F001: { ...defaultQuestionProgress(T0), note: 'x'.repeat(MAX_REMOTE_DOC_BYTES + 100) },
      },
    });
    try {
      toRemoteData(huge);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isSyncError(error)).toBe(true);
      expect(isSyncError(error) ? error.code : '').toBe('too-large');
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════
   erasing the cloud copy: overwrite, never merge
   ═════════════════════════════════════════════════════════════════════ */

/** The document the store hands over once the local wipe has happened. */
function clearedDoc(): ProgressDoc {
  return defaultProgressDoc(DB_VERSION, T0 + 5_000);
}

/** A heavy remote document: what must *not* survive a reset. */
function heavyRemote(): ProgressDoc {
  return validDoc({
    progress: { F001: { ...defaultQuestionProgress(T0), seen: 99, correct: 80, wrong: 19 } },
    xp: 5_000,
    practiceDays: { '2026-01-01': true, '2026-01-02': true },
    badges: { 'streak-7': T0 },
  });
}

/** Stub adapter whose `resetRemote` fails, to test the caller's contract. */
function failingResetAdapter(error: unknown): SyncAdapter & RemoteResettable {
  return {
    ...createNoopSyncAdapter(),
    name: 'stub-failing',
    configured: true,
    async resetRemote(): Promise<void> {
      throw error;
    },
  };
}

describe('remote reset', () => {
  it('is advertised by the Firestore adapter and absent from the no-op one', () => {
    expect(supportsRemoteReset(createFirestoreAdapter())).toBe(true);
    expect(supportsRemoteReset(noopSyncAdapter)).toBe(false);
    expect(supportsRemoteReset(createNoopSyncAdapter())).toBe(false);
  });

  it('is a silent no-op on the unconfigured adapter', async () => {
    const adapter = createFirestoreAdapter();
    await expect(adapter.resetRemote(clearedDoc())).resolves.toBeUndefined();
    // Nothing happened, and nothing to report: unconfigured is not a failure.
    expect(adapter.status()).toBe('signed-out');
  });

  it('can be called unconditionally through the helper, whatever the adapter', async () => {
    // This is the property the store relies on: no `configured` check needed.
    await expect(resetRemoteProgress(noopSyncAdapter, clearedDoc())).resolves.toBeUndefined();
    await expect(
      resetRemoteProgress(createFirestoreAdapter(), clearedDoc()),
    ).resolves.toBeUndefined();
  });

  it('hands the adapter exactly the cleared document it was given', async () => {
    const received: ProgressDoc[] = [];
    const adapter: SyncAdapter & RemoteResettable = {
      ...createNoopSyncAdapter(),
      name: 'stub-recording',
      configured: true,
      async resetRemote(cleared: ProgressDoc): Promise<void> {
        received.push(cleared);
      },
    };
    const cleared = clearedDoc();
    await resetRemoteProgress(adapter, cleared);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(cleared);
  });

  it('writes an overwrite payload with no trace of the old data', () => {
    const payload = resetRemotePayload(clearedDoc());
    // Byte-for-byte the cleared document, and nothing else.
    expect(payload).toEqual(asRemote(clearedDoc()));
    expect(payload['progress']).toEqual({});
    expect(payload['sessions']).toEqual([]);
    expect(payload['mocks']).toEqual([]);
    expect(payload['practiceDays']).toEqual({});
    expect(payload['badges']).toEqual({});
    expect(payload['xp']).toBe(0);
  });

  it('does not merge: a heavy remote document cannot survive the reset', () => {
    const remote = heavyRemote();
    const cleared = clearedDoc();

    // This is the bug the reset path exists to prevent. Going through the merge
    // — which is what any *push* after a local wipe would do — resurrects
    // everything the user just deleted:
    const ifItMerged = mergeDocs(remote, cleared);
    expect(ifItMerged.progress['F001']?.seen).toBe(99);
    expect(ifItMerged.xp).toBe(5_000);
    expect(ifItMerged.sessions).toHaveLength(1);
    expect(Object.keys(ifItMerged.practiceDays)).toHaveLength(2);

    // The reset payload shares nothing with it.
    const payload = resetRemotePayload(cleared);
    expect(payload['progress']).toEqual({});
    expect(payload['xp']).toBe(0);
    expect(payload['sessions']).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain('F001');
    expect(JSON.stringify(payload)).not.toContain('"s1"');
    expect(JSON.stringify(payload)).not.toContain('streak-7');
  });

  it('writes something the validator and the security rules accept', () => {
    // A reset must not leave a document that later fails `parseRemoteProgressDoc`
    // (which would make every later push refuse with 'remote-unreadable').
    const cleared = clearedDoc();
    const parsed = parseRemoteProgressDoc(resetRemotePayload(cleared));
    expect(parsed).toEqual(cleared);
    // All nine top-level fields present, as `isProgressDoc()` in
    // firestore.rules requires of every write.
    expect(Object.keys(resetRemotePayload(cleared)).sort()).toEqual([
      'badges',
      'mocks',
      'practiceDays',
      'progress',
      'schemaVersion',
      'sessions',
      'settings',
      'updatedAt',
      'xp',
    ]);
  });

  it('surfaces a failure as a typed error rather than swallowing it', async () => {
    const cause = new Error('permission-denied');
    const rejected = resetRemoteProgress(failingResetAdapter(cause), clearedDoc());
    await expect(rejected).rejects.toBeInstanceOf(SyncError);
    // Normalised to one code, with the original error kept for the console.
    await rejected.catch((error: unknown) => {
      expect(isSyncError(error) ? error.code : '').toBe('reset-failed');
      expect(isSyncError(error) ? error.cause : null).toBe(cause);
    });
  });

  it('passes an adapter SyncError through unchanged, so the UI can branch', async () => {
    const original = new SyncError('signed-out', 'nobody is signed in');
    await resetRemoteProgress(failingResetAdapter(original), clearedDoc()).then(
      () => {
        expect.unreachable('should have rejected');
      },
      (error: unknown) => {
        // Same instance: 'signed-out' is recoverable ("sign in again and retry")
        // and must not be flattened into the generic failure code.
        expect(error).toBe(original);
        expect(isSyncError(error) ? error.code : '').toBe('signed-out');
      },
    );
  });

  it('normalises a non-Error rejection too', async () => {
    await resetRemoteProgress(failingResetAdapter('boom'), clearedDoc()).then(
      () => {
        expect.unreachable('should have rejected');
      },
      (error: unknown) => {
        expect(isSyncError(error)).toBe(true);
        expect(isSyncError(error) ? error.code : '').toBe('reset-failed');
        expect(isSyncError(error) ? error.cause : null).toBe('boom');
      },
    );
  });

  it('leaves the already-wiped local document intact when the remote reset fails', async () => {
    // The store wipes locally first, then calls us. A failure here must not roll
    // that back — the user asked for the data to be gone and it is gone locally.
    const cleared = clearedDoc();
    await replaceProgressDoc(cleared, T0 + 5_000);
    const before = await loadProgressDoc();
    expect(before.progress).toEqual({});
    expect(before.xp).toBe(0);

    await expect(
      resetRemoteProgress(failingResetAdapter(new Error('unavailable')), cleared),
    ).rejects.toBeInstanceOf(SyncError);

    const after = await loadProgressDoc();
    // Untouched: this path performs no local writes at all, successful or not.
    expect(after).toEqual(before);
  });

  it('bounds how long a reset can take, so the UI cannot hang', () => {
    // A Firestore write only resolves once the server acknowledges it, so with
    // no network it would never settle. The reset is bounded and fails loudly.
    expect(RESET_TIMEOUT_MS).toBeGreaterThan(0);
    expect(RESET_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    const source = readFileSync(join(process.cwd(), 'src/lib/sync/firestore.ts'), 'utf8');
    expect(source).toContain('withTimeout(');
    // The overwrite is a plain two-argument `setDoc`: no `{ merge: true }`
    // option, and not inside the read-merge-write transaction. Pinning the exact
    // call is the only way to assert that from here — a third argument or a
    // `runTransaction` wrapper would fail this.
    expect(source).toContain(
      'setDoc(doc(handle.firestore, USERS_COLLECTION, uid), resetRemotePayload(cleared)),',
    );
  });
});
