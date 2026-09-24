import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MockResult, QuestionProgress, SessionResult } from '@/types';
import {
  addXp,
  appendMock,
  appendSession,
  awardBadge,
  closeDb,
  dayKey,
  deleteDb,
  DB_NAME,
  DB_VERSION,
  getDbInfo,
  getQuestionProgress,
  getSettings,
  loadProgressDoc,
  markPracticeDay,
  openDb,
  putQuestionProgress,
  putQuestionProgressBulk,
  replaceProgressDoc,
  resetAll,
  resetState,
  saveSettings,
  setLastSyncAt,
} from './index';
import { defaultProgressDoc, defaultQuestionProgress, DEFAULT_EASE, stateKeyRange } from './schema';
import { isPersisted, requestPersistentStorage, storageEstimate } from './persist';

const T0 = 1_700_000_000_000;

function progress(overrides: Partial<QuestionProgress> = {}): QuestionProgress {
  return { ...defaultQuestionProgress(T0), seen: 1, ...overrides };
}

function session(id: string, state: SessionResult['state'], finishedAt = T0): SessionResult {
  return {
    id,
    mode: 'learn',
    state,
    startedAt: finishedAt - 60_000,
    finishedAt,
    answers: [{ questionId: `${state}01`, chosen: 'a', correct: true, hintsUsed: 0, ms: 900 }],
    correct: 1,
    total: 1,
  };
}

function mock(id: string, state: MockResult['state'], finishedAt = T0): MockResult {
  return {
    id,
    state,
    startedAt: finishedAt - 3_600_000,
    finishedAt,
    durationMs: 3_600_000,
    answers: [{ questionId: 'F001', chosen: 'b', correct: false, hintsUsed: 0, ms: 500 }],
    correct: 16,
    total: 33,
    passed: false,
  };
}

/** Write a value IndexedDB accepts but our schema does not, bypassing the typed API. */
async function corrupt(store: string, value: unknown, key: string): Promise<void> {
  // Make sure the schema exists, then hand the file over to a raw connection so
  // no cast is needed to write something the typed API would reject.
  await openDb();
  await closeDb();
  const open = indexedDB.open(DB_NAME, DB_VERSION);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('open failed'));
  });
  try {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('tx failed'));
    });
  } finally {
    // Always close: a leaked connection would block every later `deleteDb()`.
    db.close();
  }
}

beforeEach(async () => {
  await deleteDb();
});

describe('a fresh database', () => {
  it('boots into onboarding rather than crashing', async () => {
    const doc = await loadProgressDoc();
    expect(doc).toEqual(defaultProgressDoc(DB_VERSION));
    expect(doc.settings.state).toBeNull();
    expect(doc.settings.onboarded).toBe(false);
    expect(doc.schemaVersion).toBe(DB_VERSION);
  });

  it('seeds a stable install and device id', async () => {
    const info = await getDbInfo();
    expect(info.installId).not.toBe('');
    expect(info.deviceId).not.toBe('');
    expect(info.lastSyncAt).toBeNull();
    expect(info.schemaVersion).toBe(DB_VERSION);

    await closeDb();
    const again = await getDbInfo();
    expect(again.installId).toBe(info.installId);
  });

  it('returns null for a question that has never been seen', async () => {
    expect(await getQuestionProgress('F001')).toBeNull();
  });
});

describe('settings', () => {
  it('merges patches and stamps updatedAt', async () => {
    const first = await saveSettings({ state: 'BW', onboarded: true }, T0);
    expect(first.state).toBe('BW');
    expect(first.onboarded).toBe(true);
    expect(first.uiLocale).toBe('de');
    expect(first.updatedAt).toBe(T0);

    const second = await saveSettings({ uiLocale: 'tr' }, T0 + 1_000);
    expect(second.state).toBe('BW');
    expect(second.uiLocale).toBe('tr');
    expect(second.updatedAt).toBe(T0 + 1_000);

    expect(await getSettings()).toEqual(second);
  });

  it('falls back to defaults when the stored record is garbage', async () => {
    await saveSettings({ state: 'HH' }, T0);
    await corrupt('settings', 'not-a-settings-object', 'settings');
    const settings = await getSettings();
    expect(settings.state).toBeNull();
    expect(settings.onboarded).toBe(false);
  });

  it('keeps the fields it can when the record is only partly valid', async () => {
    await corrupt('settings', { state: 'SN', theme: 'nope', onboarded: true }, 'settings');
    const settings = await getSettings();
    expect(settings.state).toBe('SN');
    expect(settings.theme).toBe('system');
    expect(settings.onboarded).toBe(true);
  });
});

describe('writes', () => {
  it('stores and reads per-question progress', async () => {
    await putQuestionProgress('F001', progress({ correct: 3, note: 'hi' }), T0);
    expect(await getQuestionProgress('F001')).toEqual(progress({ correct: 3, note: 'hi' }));
    expect((await getDbInfo()).updatedAt).toBe(T0);
  });

  it('writes many progress records in one go', async () => {
    await putQuestionProgressBulk(
      { F001: progress({ seen: 2 }), BW03: progress({ seen: 5 }) },
      T0,
    );
    const doc = await loadProgressDoc();
    expect(Object.keys(doc.progress).sort()).toEqual(['BW03', 'F001']);
  });

  it('appends sessions and mocks, sorted oldest first', async () => {
    await appendSession(session('s2', 'BW', T0 + 2_000));
    await appendSession(session('s1', 'BW', T0 + 1_000));
    await appendMock(mock('m1', 'BW'));
    const doc = await loadProgressDoc();
    expect(doc.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(doc.mocks.map((m) => m.id)).toEqual(['m1']);
  });

  it('treats an appended session id as an upsert, never a duplicate', async () => {
    await appendSession(session('s1', 'BW'));
    await appendSession(session('s1', 'BW'));
    expect((await loadProgressDoc()).sessions).toHaveLength(1);
  });

  it('marks practice days', async () => {
    await markPracticeDay('2025-03-01');
    await markPracticeDay('2025-03-01');
    await markPracticeDay('2025-03-02');
    expect((await loadProgressDoc()).practiceDays).toEqual({
      '2025-03-01': true,
      '2025-03-02': true,
    });
  });

  it('derives a local YYYY-MM-DD day key', () => {
    expect(dayKey(new Date(2025, 0, 5, 13, 30).getTime())).toBe('2025-01-05');
    expect(dayKey(new Date(2025, 10, 30, 0, 1).getTime())).toBe('2025-11-30');
  });

  it('awards a badge once, keeping the earliest date', async () => {
    expect(await awardBadge('streak-7', T0 + 5_000)).toBe(T0 + 5_000);
    expect(await awardBadge('streak-7', T0)).toBe(T0);
    expect(await awardBadge('streak-7', T0 + 9_000)).toBe(T0);
    expect((await loadProgressDoc()).badges).toEqual({ 'streak-7': T0 });
  });

  it('accumulates xp and never goes negative', async () => {
    expect(await addXp(10)).toBe(10);
    expect(await addXp(15)).toBe(25);
    expect(await addXp(-100)).toBe(0);
    expect((await loadProgressDoc()).xp).toBe(0);
  });

  it('records the last sync timestamp', async () => {
    await setLastSyncAt(T0);
    expect((await getDbInfo()).lastSyncAt).toBe(T0);
    await setLastSyncAt(null);
    expect((await getDbInfo()).lastSyncAt).toBeNull();
  });
});

describe('resilience', () => {
  it('skips corrupt progress rows instead of failing the whole read', async () => {
    await putQuestionProgress('F001', progress({ seen: 7 }), T0);
    await corrupt('progress', 'totally bogus', 'BW09');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = await loadProgressDoc();
    warn.mockRestore();
    expect(doc.progress['F001']?.seen).toBe(7);
    expect(doc.progress['BW09']).toBeUndefined();
  });

  it('reads v1-shaped progress rows without ease/dueAt/flagged', async () => {
    await corrupt(
      'progress',
      { seen: 3, correct: 2, wrong: 1, consecutiveCorrect: 0, hintsUsed: 0, lastSeen: T0, note: 'n', updatedAt: T0 },
      'F004',
    );
    const row = await getQuestionProgress('F004');
    expect(row?.ease).toBe(DEFAULT_EASE);
    expect(row?.dueAt).toBe(T0);
    expect(row?.flagged).toBe(false);
    expect(row?.note).toBe('n');
  });

  it('ignores a non-numeric badge value', async () => {
    await awardBadge('good', T0);
    await corrupt('badges', 'yesterday', 'bad');
    const doc = await loadProgressDoc();
    expect(doc.badges).toEqual({ good: T0 });
  });
});

describe('replaceProgressDoc', () => {
  it('overwrites every data store atomically', async () => {
    await saveSettings({ state: 'BE', onboarded: true }, T0);
    await putQuestionProgress('F001', progress({ seen: 4 }), T0);
    await appendSession(session('old', 'BE'));

    const replacement = {
      ...defaultProgressDoc(DB_VERSION, T0),
      settings: { ...(await getSettings()), state: 'HB' as const },
      progress: { BW02: progress({ seen: 9 }) },
      sessions: [session('new', 'HB')],
      badges: { imported: T0 },
      xp: 42,
    };
    await replaceProgressDoc(replacement, T0 + 1);

    const doc = await loadProgressDoc();
    expect(doc.settings.state).toBe('HB');
    expect(Object.keys(doc.progress)).toEqual(['BW02']);
    expect(doc.sessions.map((s) => s.id)).toEqual(['new']);
    expect(doc.badges).toEqual({ imported: T0 });
    expect(doc.xp).toBe(42);
  });
});

describe('resetState', () => {
  beforeEach(async () => {
    await saveSettings({ state: 'BW', onboarded: true }, T0);
    await putQuestionProgressBulk(
      {
        F001: progress({ seen: 1 }),
        F123: progress({ seen: 2 }),
        BW01: progress({ seen: 3 }),
        BW12: progress({ seen: 4 }),
        BY01: progress({ seen: 5 }),
        SH01: progress({ seen: 6 }),
      },
      T0,
    );
    await appendSession(session('s-bw', 'BW'));
    await appendSession(session('s-by', 'BY'));
    await appendMock(mock('m-bw', 'BW'));
    await appendMock(mock('m-by', 'BY'));
    await markPracticeDay('2025-05-05');
    await awardBadge('streak-3', T0);
    await addXp(100);
  });

  it('deletes only that state, by key prefix', async () => {
    const removed = await resetState('BW', T0 + 1);
    expect(removed).toBe(2);

    const doc = await loadProgressDoc();
    expect(Object.keys(doc.progress).sort()).toEqual(['BY01', 'F001', 'F123', 'SH01']);
    expect(doc.sessions.map((s) => s.id)).toEqual(['s-by']);
    expect(doc.mocks.map((m) => m.id)).toEqual(['m-by']);
  });

  it('leaves global data — settings, xp, badges, streaks — alone', async () => {
    await resetState('BW', T0 + 1);
    const doc = await loadProgressDoc();
    expect(doc.settings.state).toBe('BW');
    expect(doc.settings.onboarded).toBe(true);
    expect(doc.xp).toBe(100);
    expect(doc.badges).toEqual({ 'streak-3': T0 });
    expect(doc.practiceDays).toEqual({ '2025-05-05': true });
  });

  it('is a no-op for a state with no progress', async () => {
    expect(await resetState('TH', T0 + 1)).toBe(0);
    expect(Object.keys((await loadProgressDoc()).progress)).toHaveLength(6);
  });

  it('scopes the key range to exactly one state', async () => {
    const db = await openDb();
    expect(await db.count('progress', stateKeyRange('BW'))).toBe(2);
    expect(await db.count('progress', stateKeyRange('BY'))).toBe(1);
    expect(await db.count('progress', stateKeyRange('TH'))).toBe(0);
  });
});

describe('resetAll', () => {
  it('wipes everything but keeps the device identity', async () => {
    await saveSettings({ state: 'NW', onboarded: true }, T0);
    await putQuestionProgress('F001', progress(), T0);
    await appendSession(session('s1', 'NW'));
    await awardBadge('b', T0);
    await addXp(50);
    const before = await getDbInfo();

    await resetAll(T0 + 1);

    const doc = await loadProgressDoc();
    expect(doc.settings.state).toBeNull();
    expect(doc.settings.onboarded).toBe(false);
    expect(doc.progress).toEqual({});
    expect(doc.sessions).toEqual([]);
    expect(doc.mocks).toEqual([]);
    expect(doc.badges).toEqual({});
    expect(doc.xp).toBe(0);

    const after = await getDbInfo();
    expect(after.installId).toBe(before.installId);
    expect(after.deviceId).toBe(before.deviceId);
    expect(after.lastSyncAt).toBeNull();
  });
});

describe('persistent storage', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'storage');

  function stubStorage(value: unknown): void {
    Object.defineProperty(globalThis.navigator, 'storage', {
      value,
      configurable: true,
      writable: true,
    });
  }

  afterEach(() => {
    if (original === undefined) {
      Reflect.deleteProperty(globalThis.navigator, 'storage');
    } else {
      Object.defineProperty(globalThis.navigator, 'storage', original);
    }
  });

  it('reports unsupported when there is no Storage API', async () => {
    stubStorage(undefined);
    expect(await requestPersistentStorage()).toBe('unsupported');
    expect(await isPersisted()).toBe('unsupported');
    expect(await storageEstimate()).toEqual({
      supported: false,
      usage: null,
      quota: null,
      usedFraction: null,
    });
  });

  it('maps persist() true/false onto granted/denied', async () => {
    stubStorage({ persist: async () => true, persisted: async () => false });
    expect(await requestPersistentStorage()).toBe('granted');
    expect(await isPersisted()).toBe('denied');
  });

  it('never throws when the Storage API rejects', async () => {
    stubStorage({
      persist: async () => {
        throw new Error('nope');
      },
      persisted: async () => {
        throw new Error('nope');
      },
      estimate: async () => {
        throw new Error('nope');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await requestPersistentStorage()).toBe('denied');
    expect(await isPersisted()).toBe('denied');
    expect((await storageEstimate()).supported).toBe(false);
    warn.mockRestore();
  });

  it('computes the used fraction from an estimate', async () => {
    stubStorage({ estimate: async () => ({ usage: 250, quota: 1_000 }) });
    expect(await storageEstimate()).toEqual({
      supported: true,
      usage: 250,
      quota: 1_000,
      usedFraction: 0.25,
    });
  });
});
