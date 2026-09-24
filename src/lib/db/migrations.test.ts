import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DB_VERSION,
  MIGRATIONS,
  migrationLadderIsSane,
  migrationsFor,
} from './migrations';
import { DB_NAME, DEFAULT_EASE } from './schema';
import { closeDb, deleteDb, loadProgressDoc, openDb } from './index';

/* ───────────────────────── raw IndexedDB helpers ────────────────────── */

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDBRequest failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

/**
 * Open the database at an explicit old version using the raw API, i.e. exactly
 * what a user running an older build would have on disk. Deliberately does NOT
 * reuse `migrations.ts`: the point is to prove the upgrade path works against
 * data this code has never seen.
 */
async function createLegacyDb(
  version: number,
  buildSchema: (db: IDBDatabase) => void,
  seed: (db: IDBDatabase) => Promise<void>,
): Promise<void> {
  const open = indexedDB.open(DB_NAME, version);
  open.onupgradeneeded = () => buildSchema(open.result);
  const db = await request<IDBDatabase>(open);
  await seed(db);
  db.close();
}

/** The v1 schema, hand-written as the first shipped build had it. */
function buildV1Schema(db: IDBDatabase): void {
  db.createObjectStore('meta');
  db.createObjectStore('settings');
  db.createObjectStore('progress');
  db.createObjectStore('sessions', { keyPath: 'id' });
  db.createObjectStore('mocks', { keyPath: 'id' });
  db.createObjectStore('practiceDays');
  db.createObjectStore('badges');
}

const T0 = 1_700_000_000_000;

/** A v1 progress record: counters + a bare `note`, no ease/dueAt/flagged. */
function v1Progress(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seen: 4,
    correct: 3,
    wrong: 1,
    consecutiveCorrect: 2,
    hintsUsed: 1,
    lastSeen: T0,
    note: 'Bundesrat ≠ Bundestag',
    updatedAt: T0,
    ...overrides,
  };
}

/** A v1 session: no `state` field at all. */
function v1Session(id: string, questionIds: readonly string[]): Record<string, unknown> {
  return {
    id,
    mode: 'learn',
    startedAt: T0,
    finishedAt: T0 + 60_000,
    answers: questionIds.map((questionId) => ({
      questionId,
      chosen: 'a',
      correct: true,
      hintsUsed: 0,
      ms: 1_200,
    })),
    correct: questionIds.length,
    total: questionIds.length,
  };
}

async function seedV1Data(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(
    ['settings', 'progress', 'sessions', 'mocks', 'practiceDays', 'badges', 'meta'],
    'readwrite',
  );
  tx.objectStore('settings').put(
    {
      state: 'BY',
      uiLocale: 'en',
      translation: 'en',
      alwaysShowTranslation: true,
      mockTranslations: false,
      recallFirst: false,
      tts: false,
      ttsAutoplay: false,
      theme: 'dark',
      onboarded: true,
      updatedAt: T0,
    },
    'settings',
  );
  tx.objectStore('progress').put(v1Progress(), 'F001');
  tx.objectStore('progress').put(v1Progress({ seen: 9, note: '', correct: 9 }), 'BW05');
  // One session that touched a state question (state is inferable) and one that
  // touched only federal questions (state must come from settings).
  tx.objectStore('sessions').put(v1Session('s-state', ['BW05', 'F001']));
  tx.objectStore('sessions').put(v1Session('s-federal', ['F001']));
  tx.objectStore('mocks').put({
    id: 'm1',
    startedAt: T0,
    finishedAt: T0 + 3_600_000,
    durationMs: 3_600_000,
    answers: [{ questionId: 'F001', chosen: 'a', correct: true, hintsUsed: 0, ms: 900 }],
    correct: 1,
    total: 1,
    passed: false,
  });
  tx.objectStore('practiceDays').put(true, '2025-01-01');
  tx.objectStore('practiceDays').put(true, '2025-01-02');
  tx.objectStore('badges').put(T0, 'first-session');
  tx.objectStore('meta').put(250, 'xp');
  await done(tx);
}

/* ──────────────────────────────── tests ─────────────────────────────── */

describe('migration ladder', () => {
  beforeEach(async () => {
    await deleteDb();
  });

  it('is an ordered, gapless list of named steps', () => {
    expect(migrationLadderIsSane()).toBe(true);
    expect(MIGRATIONS.map((m) => m.name)).toEqual([
      'initial-schema',
      'progress-spaced-repetition',
      'sync-and-snapshots',
    ]);
    expect(DB_VERSION).toBe(MIGRATIONS.length);
    for (const m of MIGRATIONS) expect(m.description.length).toBeGreaterThan(20);
  });

  it('selects exactly the steps between two versions, in order', () => {
    expect(migrationsFor(0, DB_VERSION).map((m) => m.version)).toEqual([1, 2, 3]);
    expect(migrationsFor(1, DB_VERSION).map((m) => m.name)).toEqual([
      'progress-spaced-repetition',
      'sync-and-snapshots',
    ]);
    expect(migrationsFor(2, DB_VERSION).map((m) => m.name)).toEqual(['sync-and-snapshots']);
    expect(migrationsFor(DB_VERSION, DB_VERSION)).toEqual([]);
  });
});

describe('fresh install (version 0 → current)', () => {
  beforeEach(async () => {
    await deleteDb();
  });

  it('creates every store and returns a valid empty document', async () => {
    const db = await openDb();
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual([
      'badges',
      'meta',
      'mocks',
      'outbox',
      'practiceDays',
      'progress',
      'sessions',
      'settings',
      'snapshots',
    ]);

    const doc = await loadProgressDoc();
    expect(doc.settings.state).toBeNull();
    expect(doc.settings.onboarded).toBe(false);
    expect(doc.progress).toEqual({});
    expect(doc.sessions).toEqual([]);
    expect(doc.xp).toBe(0);
  });
});

describe('v1 → v2 → current (chained)', () => {
  beforeEach(async () => {
    await deleteDb();
  });

  it('upgrades v1 records through every step without losing anything', async () => {
    await createLegacyDb(1, buildV1Schema, seedV1Data);

    // Reopen at the current version: v2 and v3 must both run, in order.
    const db = await openDb();
    expect(db.version).toBe(DB_VERSION);

    const doc = await loadProgressDoc();

    // --- v2: spaced-repetition fields backfilled, v1 data preserved verbatim.
    const federal = doc.progress['F001'];
    expect(federal).toBeDefined();
    expect(federal?.seen).toBe(4);
    expect(federal?.correct).toBe(3);
    expect(federal?.wrong).toBe(1);
    expect(federal?.consecutiveCorrect).toBe(2);
    expect(federal?.hintsUsed).toBe(1);
    expect(federal?.lastSeen).toBe(T0);
    expect(federal?.note).toBe('Bundesrat ≠ Bundestag');
    expect(federal?.ease).toBe(DEFAULT_EASE);
    expect(federal?.dueAt).toBe(T0);
    expect(federal?.flagged).toBe(false);

    const state = doc.progress['BW05'];
    expect(state?.seen).toBe(9);
    expect(state?.note).toBe('');
    expect(state?.ease).toBe(DEFAULT_EASE);

    // Nothing dropped.
    expect(Object.keys(doc.progress).sort()).toEqual(['BW05', 'F001']);

    // --- v3: new stores exist and legacy records gained a state.
    expect(db.objectStoreNames.contains('snapshots')).toBe(true);
    expect(db.objectStoreNames.contains('outbox')).toBe(true);

    const bwSession = doc.sessions.find((s) => s.id === 's-state');
    const federalSession = doc.sessions.find((s) => s.id === 's-federal');
    expect(bwSession?.state).toBe('BW'); // inferred from the BW05 answer
    expect(federalSession?.state).toBe('BY'); // fell back to the saved settings
    expect(doc.sessions).toHaveLength(2);
    expect(bwSession?.answers).toHaveLength(2);
    expect(doc.mocks[0]?.state).toBe('BY');
    expect(doc.mocks[0]?.durationMs).toBe(3_600_000);

    // --- everything else survived untouched.
    expect(doc.settings.state).toBe('BY');
    expect(doc.settings.uiLocale).toBe('en');
    expect(doc.settings.theme).toBe('dark');
    expect(doc.settings.onboarded).toBe(true);
    expect(doc.practiceDays).toEqual({ '2025-01-01': true, '2025-01-02': true });
    expect(doc.badges).toEqual({ 'first-session': T0 });
    expect(doc.xp).toBe(250);
  });

  it('creates the by-state indexes the scoped reset depends on', async () => {
    await createLegacyDb(1, buildV1Schema, seedV1Data);
    const db = await openDb();
    const tx = db.transaction(['sessions', 'mocks'], 'readonly');
    expect([...tx.objectStore('sessions').indexNames].sort()).toEqual([
      'by-finishedAt',
      'by-state',
    ]);
    expect([...tx.objectStore('mocks').indexNames].sort()).toEqual(['by-finishedAt', 'by-state']);
    await tx.done;
    // The index is usable straight away, i.e. the backfill actually landed.
    expect(await db.countFromIndex('sessions', 'by-state', 'BW')).toBe(1);
    expect(await db.countFromIndex('sessions', 'by-state', 'BY')).toBe(1);
  });
});

describe('v2 → current (single step)', () => {
  beforeEach(async () => {
    await deleteDb();
  });

  it('runs only the v3 step and leaves already-migrated fields alone', async () => {
    await createLegacyDb(
      2,
      (db) => {
        buildV1Schema(db);
      },
      async (db) => {
        const tx = db.transaction(['progress', 'sessions'], 'readwrite');
        // A v2-shaped record: ease/dueAt/flagged already present and NOT default.
        tx.objectStore('progress').put(
          {
            seen: 2,
            correct: 1,
            wrong: 1,
            consecutiveCorrect: 0,
            hintsUsed: 0,
            lastSeen: T0,
            ease: 1.9,
            dueAt: T0 + 86_400_000,
            flagged: true,
            note: 'keep me',
            updatedAt: T0,
          },
          'SN02',
        );
        tx.objectStore('sessions').put(v1Session('s-sn', ['SN02']));
        await done(tx);
      },
    );

    const doc = await loadProgressDoc();
    const sn = doc.progress['SN02'];
    expect(sn?.ease).toBe(1.9);
    expect(sn?.dueAt).toBe(T0 + 86_400_000);
    expect(sn?.flagged).toBe(true);
    expect(sn?.note).toBe('keep me');
    expect(doc.sessions[0]?.state).toBe('SN');
  });
});

describe('reopening an already-current database', () => {
  beforeEach(async () => {
    await deleteDb();
  });

  it('runs no migrations and preserves data across a close/reopen cycle', async () => {
    const first = await openDb();
    await first.put('progress', {
      seen: 1,
      correct: 1,
      wrong: 0,
      consecutiveCorrect: 1,
      hintsUsed: 0,
      lastSeen: T0,
      ease: DEFAULT_EASE,
      dueAt: T0,
      flagged: false,
      note: '',
      updatedAt: T0,
    }, 'F002');
    const installId = (await first.get('meta', 'installId')) ?? '';

    await closeDb();

    const second = await openDb();
    expect(second.version).toBe(DB_VERSION);
    expect(await second.get('meta', 'installId')).toBe(installId);
    const doc = await loadProgressDoc();
    expect(doc.progress['F002']?.seen).toBe(1);
  });
});
