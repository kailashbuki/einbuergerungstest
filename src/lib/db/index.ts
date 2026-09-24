/**
 * The local durability layer: a small, fully typed, async API over IndexedDB.
 *
 * Everything the app persists goes through here. The rules:
 *
 * - **Async only.** No synchronous reads, ever — the UI thread must never block
 *   on storage, no matter how big the document gets.
 * - **Never throw on read.** A corrupt or partial record must not brick the app,
 *   so reads are coerced through `schema.ts` and fall back to defaults with a
 *   console warning.
 * - **Complete defaults.** `loadProgressDoc()` on a brand-new database returns a
 *   valid `ProgressDoc` with `settings.state === null` and `onboarded === false`,
 *   which is what makes the app boot into onboarding instead of crashing.
 * - **Writes are local-first.** Nothing here talks to the network. Sync is a
 *   separate concern that drains `outbox.ts`.
 */

import { openDB, deleteDB, type IDBPDatabase } from 'idb';
import type {
  MockResult,
  ProgressDoc,
  QuestionId,
  QuestionProgress,
  SessionResult,
  Settings,
  StateCode,
} from '@/types';
import {
  ALL_STORES,
  coerceMockResult,
  coerceQuestionProgress,
  coerceSessionResult,
  coerceSettings,
  DATA_STORES,
  DB_NAME,
  defaultProgressDoc,
  defaultSettings,
  FALLBACK_STATE,
  SETTINGS_KEY,
  stateKeyRange,
  type EbtDBSchema,
  type MetaKey,
} from './schema';
import { DB_VERSION, runMigrations } from './migrations';

export type EbtDB = IDBPDatabase<EbtDBSchema>;

export { DB_NAME, DB_VERSION };
export {
  defaultProgressDoc,
  defaultQuestionProgress,
  defaultSettings,
  coerceQuestionProgress,
  coerceSettings,
} from './schema';
export type { EbtDBSchema } from './schema';

/* ─────────────────────────────── logging ────────────────────────────── */

function warn(message: string, error?: unknown): void {
  // Deliberately console-only: storage problems are recoverable and must never
  // become exceptions the UI has to handle.
  if (error === undefined) console.warn(`[db] ${message}`);
  else console.warn(`[db] ${message}`, error);
}

/** Run a read, returning `fallback` (and logging) if anything goes wrong. */
async function safeRead<T>(label: string, read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    warn(`read failed: ${label} — falling back to defaults`, error);
    return fallback;
  }
}

/* ────────────────────────────── connection ──────────────────────────── */

let connection: Promise<EbtDB> | null = null;

function randomId(): string {
  const maybeCrypto: Crypto | undefined = globalThis.crypto;
  if (maybeCrypto !== undefined && typeof maybeCrypto.randomUUID === 'function') {
    return maybeCrypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Open (or reuse) the database, running any pending migrations.
 *
 * The connection is memoised so concurrent callers share one handle. Errors from
 * the upgrade transaction are surfaced here rather than swallowed as unhandled
 * rejections inside the `upgrade` callback.
 */
export async function openDb(): Promise<EbtDB> {
  if (connection !== null) return connection;
  connection = (async (): Promise<EbtDB> => {
    // Collected in an array so the migration promise survives the sync callback
    // without tripping control-flow narrowing.
    const pendingUpgrades: Promise<readonly string[]>[] = [];
    const db = await openDB<EbtDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion, newVersion, tx) {
        pendingUpgrades.push(runMigrations(database, tx, oldVersion, newVersion ?? DB_VERSION));
      },
      blocked() {
        warn('another tab holds an older version of the database open');
      },
      blocking() {
        warn('a newer version wants to open; closing this connection');
        void closeDb();
      },
      terminated() {
        warn('connection terminated abnormally; will reopen on next use');
        connection = null;
      },
    });
    // `openDB` resolves after the upgrade transaction commits, so awaiting here
    // reports migration failures to the caller instead of losing them.
    await Promise.all(pendingUpgrades);
    await ensureMeta(db);
    return db;
  })();
  try {
    return await connection;
  } catch (error) {
    connection = null;
    throw error;
  }
}

/** Close the shared connection. The next call to `openDb()` reopens it. */
export async function closeDb(): Promise<void> {
  const current = connection;
  connection = null;
  if (current === null) return;
  try {
    (await current).close();
  } catch (error) {
    warn('closing the database failed', error);
  }
}

/** Delete the whole database. Used by tests and by the Settings "danger zone". */
export async function deleteDb(): Promise<void> {
  await closeDb();
  await deleteDB(DB_NAME, {
    blocked() {
      warn('database delete is blocked by another connection');
    },
  });
}

/** Seed the identity fields a fresh install needs. Idempotent. */
async function ensureMeta(db: EbtDB): Promise<void> {
  try {
    const tx = db.transaction('meta', 'readwrite');
    const store = tx.objectStore('meta');
    const existingInstall = await store.get('installId');
    if (typeof existingInstall !== 'string' || existingInstall === '') {
      await store.put(randomId(), 'installId');
    }
    const existingDevice = await store.get('deviceId');
    if (typeof existingDevice !== 'string' || existingDevice === '') {
      await store.put(randomId(), 'deviceId');
    }
    await store.put(DB_VERSION, 'schemaVersion');
    await tx.done;
  } catch (error) {
    warn('could not seed meta', error);
  }
}

/* ──────────────────────────── meta accessors ────────────────────────── */

async function readNumberMeta(db: EbtDB, key: MetaKey, fallback: number): Promise<number> {
  const raw = await db.get('meta', key);
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

async function readStringMeta(db: EbtDB, key: MetaKey, fallback: string): Promise<string> {
  const raw = await db.get('meta', key);
  return typeof raw === 'string' ? raw : fallback;
}

export interface DbInfo {
  readonly schemaVersion: number;
  readonly installId: string;
  readonly deviceId: string;
  readonly lastSyncAt: number | null;
  /** See {@link MetaShape.syncedUid}: which account owns the document here. */
  readonly syncedUid: string | null;
  readonly updatedAt: number;
}

export async function getDbInfo(): Promise<DbInfo> {
  const db = await openDb();
  return safeRead<DbInfo>(
    'meta',
    async () => {
      const lastSyncRaw = await db.get('meta', 'lastSyncAt');
      const syncedUidRaw = await db.get('meta', 'syncedUid');
      return {
        schemaVersion: await readNumberMeta(db, 'schemaVersion', DB_VERSION),
        installId: await readStringMeta(db, 'installId', ''),
        deviceId: await readStringMeta(db, 'deviceId', ''),
        lastSyncAt: typeof lastSyncRaw === 'number' ? lastSyncRaw : null,
        // Absent (an install predating this key) reads as unclaimed, which is the
        // safe default: the next sign-in adopts the document instead of a
        // mismatch quarantining data that really does belong to that user.
        syncedUid: typeof syncedUidRaw === 'string' && syncedUidRaw !== '' ? syncedUidRaw : null,
        updatedAt: await readNumberMeta(db, 'updatedAt', 0),
      };
    },
    {
      schemaVersion: DB_VERSION,
      installId: '',
      deviceId: '',
      lastSyncAt: null,
      syncedUid: null,
      updatedAt: 0,
    },
  );
}

/** Record a successful sync. Sync adapters call this; nothing else should. */
export async function setLastSyncAt(at: number | null): Promise<void> {
  const db = await openDb();
  await db.put('meta', at, 'lastSyncAt');
}

/**
 * Claim this device's document for `uid`, or release it with `null`.
 *
 * Called by `runSyncCycle` only, and only after a push has actually landed. See
 * {@link MetaShape.syncedUid} for why the claim exists at all.
 */
export async function setSyncedUid(uid: string | null): Promise<void> {
  const db = await openDb();
  await db.put('meta', uid, 'syncedUid');
}

/* ──────────────────────────────── reads ─────────────────────────────── */

export async function getSettings(): Promise<Settings> {
  const db = await openDb();
  return safeRead(
    'settings',
    async () => coerceSettings(await db.get('settings', SETTINGS_KEY)),
    defaultSettings(),
  );
}

export async function getQuestionProgress(id: QuestionId): Promise<QuestionProgress | null> {
  const db = await openDb();
  return safeRead(
    `progress[${id}]`,
    async () => coerceQuestionProgress(await db.get('progress', id)),
    null,
  );
}

/**
 * Load the entire document.
 *
 * Each store is read independently so one corrupt store degrades to its default
 * instead of taking the whole document with it.
 */
export async function loadProgressDoc(): Promise<ProgressDoc> {
  let db: EbtDB;
  try {
    db = await openDb();
  } catch (error) {
    warn('could not open the database; serving an empty document', error);
    return defaultProgressDoc(DB_VERSION);
  }

  const settings = await safeRead(
    'settings',
    async () => coerceSettings(await db.get('settings', SETTINGS_KEY)),
    defaultSettings(),
  );
  const fallbackState: StateCode = settings.state ?? FALLBACK_STATE;

  const progress = await safeRead<Record<QuestionId, QuestionProgress>>(
    'progress',
    async () => {
      const out: Record<QuestionId, QuestionProgress> = {};
      const tx = db.transaction('progress', 'readonly');
      let cursor = await tx.objectStore('progress').openCursor();
      while (cursor) {
        const key = cursor.key;
        const value = coerceQuestionProgress(cursor.value);
        if (typeof key === 'string' && value !== null) out[key] = value;
        cursor = await cursor.continue();
      }
      await tx.done;
      return out;
    },
    {},
  );

  const sessions = await safeRead<SessionResult[]>(
    'sessions',
    async () => {
      const raw = await db.getAll('sessions');
      const out: SessionResult[] = [];
      for (const row of raw) {
        const coerced = coerceSessionResult(row, fallbackState);
        if (coerced !== null) out.push(coerced);
      }
      out.sort((a, b) => a.finishedAt - b.finishedAt);
      return out;
    },
    [],
  );

  const mocks = await safeRead<MockResult[]>(
    'mocks',
    async () => {
      const raw = await db.getAll('mocks');
      const out: MockResult[] = [];
      for (const row of raw) {
        const coerced = coerceMockResult(row, fallbackState);
        if (coerced !== null) out.push(coerced);
      }
      out.sort((a, b) => a.finishedAt - b.finishedAt);
      return out;
    },
    [],
  );

  const practiceDays = await safeRead<Record<string, true>>(
    'practiceDays',
    async () => {
      const out: Record<string, true> = {};
      for (const key of await db.getAllKeys('practiceDays')) {
        if (typeof key === 'string' && key !== '') out[key] = true;
      }
      return out;
    },
    {},
  );

  const badges = await safeRead<Record<string, number>>(
    'badges',
    async () => {
      const out: Record<string, number> = {};
      const tx = db.transaction('badges', 'readonly');
      let cursor = await tx.objectStore('badges').openCursor();
      while (cursor) {
        const key = cursor.key;
        const value: unknown = cursor.value;
        if (typeof key === 'string' && typeof value === 'number' && Number.isFinite(value)) {
          out[key] = value;
        }
        cursor = await cursor.continue();
      }
      await tx.done;
      return out;
    },
    {},
  );

  const xp = await safeRead('xp', async () => readNumberMeta(db, 'xp', 0), 0);
  const updatedAt = await safeRead('updatedAt', async () => readNumberMeta(db, 'updatedAt', 0), 0);

  return {
    schemaVersion: DB_VERSION,
    settings,
    progress,
    sessions,
    mocks,
    practiceDays,
    badges,
    xp,
    updatedAt,
  };
}

/* ─────────────────────────────── writes ─────────────────────────────── */

/**
 * Merge a patch into the stored settings and stamp `updatedAt`.
 *
 * A patch (rather than a whole record) keeps callers honest: they cannot
 * accidentally revert a field written by another tab between read and write.
 */
export async function saveSettings(patch: Partial<Settings>, now = Date.now()): Promise<Settings> {
  const db = await openDb();
  const tx = db.transaction(['settings', 'meta'], 'readwrite');
  const store = tx.objectStore('settings');
  const current = coerceSettings(await store.get(SETTINGS_KEY));
  const next: Settings = { ...current, ...patch, updatedAt: now };
  await store.put(next, SETTINGS_KEY);
  await tx.objectStore('meta').put(now, 'updatedAt');
  await tx.done;
  return next;
}

export async function putQuestionProgress(
  id: QuestionId,
  value: QuestionProgress,
  now = Date.now(),
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['progress', 'meta'], 'readwrite');
  await tx.objectStore('progress').put(value, id);
  await tx.objectStore('meta').put(now, 'updatedAt');
  await tx.done;
}

/** Write many progress records in one transaction (end-of-session flush). */
export async function putQuestionProgressBulk(
  entries: Readonly<Record<QuestionId, QuestionProgress>>,
  now = Date.now(),
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['progress', 'meta'], 'readwrite');
  const store = tx.objectStore('progress');
  for (const [id, value] of Object.entries(entries)) {
    await store.put(value, id);
  }
  await tx.objectStore('meta').put(now, 'updatedAt');
  await tx.done;
}

/** Sessions are append-only and unioned by id — re-appending the same id is a no-op update. */
export async function appendSession(session: SessionResult, now = Date.now()): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['sessions', 'meta'], 'readwrite');
  await tx.objectStore('sessions').put(session);
  await tx.objectStore('meta').put(now, 'updatedAt');
  await tx.done;
}

export async function appendMock(mock: MockResult, now = Date.now()): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['mocks', 'meta'], 'readwrite');
  await tx.objectStore('mocks').put(mock);
  await tx.objectStore('meta').put(now, 'updatedAt');
  await tx.done;
}

/** `YYYY-MM-DD` in local time — streaks are a human, calendar-local concept. */
export function dayKey(at: number = Date.now()): string {
  const d = new Date(at);
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

export async function markPracticeDay(day: string = dayKey(), now = Date.now()): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['practiceDays', 'meta'], 'readwrite');
  await tx.objectStore('practiceDays').put(true, day);
  await tx.objectStore('meta').put(now, 'updatedAt');
  await tx.done;
}

/**
 * Award a badge. Earliest earn wins, so re-awarding never moves the date
 * forward — that keeps the operation mergeable without a prompt.
 */
export async function awardBadge(badge: string, earnedAt = Date.now()): Promise<number> {
  const db = await openDb();
  const tx = db.transaction(['badges', 'meta'], 'readwrite');
  const store = tx.objectStore('badges');
  const existing: unknown = await store.get(badge);
  const kept =
    typeof existing === 'number' && Number.isFinite(existing)
      ? Math.min(existing, earnedAt)
      : earnedAt;
  await store.put(kept, badge);
  await tx.objectStore('meta').put(earnedAt, 'updatedAt');
  await tx.done;
  return kept;
}

/** Add XP (never below zero) and return the new total. */
export async function addXp(delta: number, now = Date.now()): Promise<number> {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  const store = tx.objectStore('meta');
  const raw = await store.get('xp');
  const current = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  const next = Math.max(0, current + (Number.isFinite(delta) ? delta : 0));
  await store.put(next, 'xp');
  await store.put(now, 'updatedAt');
  await tx.done;
  return next;
}

/* ───────────────────────────── whole-doc ────────────────────────────── */

/**
 * Overwrite every data store with `doc`, atomically.
 *
 * Used by snapshot restore and (after merging) by import. `snapshots` and
 * `outbox` are deliberately untouched: replacing the document must not destroy
 * the user's ability to undo it, nor drop mutations that have not synced yet.
 */
export async function replaceProgressDoc(doc: ProgressDoc, now = Date.now()): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['meta', ...DATA_STORES], 'readwrite');

  const settings = tx.objectStore('settings');
  await settings.clear();
  await settings.put(coerceSettings(doc.settings), SETTINGS_KEY);

  const progress = tx.objectStore('progress');
  await progress.clear();
  for (const [id, value] of Object.entries(doc.progress)) {
    const coerced = coerceQuestionProgress(value);
    if (coerced !== null) await progress.put(coerced, id);
  }

  const fallbackState: StateCode = doc.settings.state ?? FALLBACK_STATE;

  const sessions = tx.objectStore('sessions');
  await sessions.clear();
  for (const row of doc.sessions) {
    const coerced = coerceSessionResult(row, fallbackState);
    if (coerced !== null) await sessions.put(coerced);
  }

  const mocks = tx.objectStore('mocks');
  await mocks.clear();
  for (const row of doc.mocks) {
    const coerced = coerceMockResult(row, fallbackState);
    if (coerced !== null) await mocks.put(coerced);
  }

  const practiceDays = tx.objectStore('practiceDays');
  await practiceDays.clear();
  for (const day of Object.keys(doc.practiceDays)) {
    await practiceDays.put(true, day);
  }

  const badges = tx.objectStore('badges');
  await badges.clear();
  for (const [badge, at] of Object.entries(doc.badges)) {
    if (typeof at === 'number' && Number.isFinite(at)) await badges.put(at, badge);
  }

  const meta = tx.objectStore('meta');
  await meta.put(Number.isFinite(doc.xp) ? Math.max(0, doc.xp) : 0, 'xp');
  await meta.put(now, 'updatedAt');

  await tx.done;
}

/**
 * Wipe everything: all progress, all history, all snapshots, all queued
 * mutations. `installId` / `deviceId` survive because they identify the browser,
 * not the user's data.
 *
 * This is the "delete everything" branch of the reset flow; `resetState()` is
 * the scoped branch.
 */
export async function resetAll(now = Date.now()): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(ALL_STORES, 'readwrite');
  for (const store of DATA_STORES) {
    await tx.objectStore(store).clear();
  }
  await tx.objectStore('snapshots').clear();
  await tx.objectStore('outbox').clear();
  await tx.objectStore('settings').put(defaultSettings(now), SETTINGS_KEY);
  const meta = tx.objectStore('meta');
  await meta.put(0, 'xp');
  await meta.put(0, 'outboxSeq');
  await meta.put(null, 'lastSyncAt');
  // Release the ownership claim too: what is left is a default document that
  // represents nobody's progress, so the next sign-in should adopt it rather
  // than be told it belongs to a stranger. (`installId` and `deviceId` survive
  // by design — they identify the browser, not the data.)
  await meta.put(null, 'syncedUid');
  await meta.put(now, 'updatedAt');
  await tx.done;
}

/**
 * Reset exactly one state, leaving federal progress and every other state
 * intact.
 *
 * Scoping is a key-prefix operation: question ids are `F###` for federal
 * questions (shared by all 16 states) and `<CODE>##` for state questions, and no
 * state code begins with `F`. So deleting the key range `['BW', 'BW￿']`
 * from `progress` removes Baden-Württemberg's answers and provably nothing else.
 * Sessions and mocks carry the state they were taken under, so they are deleted
 * through the `by-state` index.
 *
 * Global things — settings, XP, badges, practice days, snapshots — are left
 * alone; "reset my Bundesland" is not "delete my account".
 */
export async function resetState(state: StateCode, now = Date.now()): Promise<number> {
  const db = await openDb();
  const tx = db.transaction(['progress', 'sessions', 'mocks', 'meta'], 'readwrite');

  const progress = tx.objectStore('progress');
  const removed = await progress.count(stateKeyRange(state));
  await progress.delete(stateKeyRange(state));

  let sessionCursor = await tx.objectStore('sessions').index('by-state').openCursor(state);
  while (sessionCursor) {
    await sessionCursor.delete();
    sessionCursor = await sessionCursor.continue();
  }

  let mockCursor = await tx.objectStore('mocks').index('by-state').openCursor(state);
  while (mockCursor) {
    await mockCursor.delete();
    mockCursor = await mockCursor.continue();
  }

  await tx.objectStore('meta').put(now, 'updatedAt');
  await tx.done;
  return removed;
}
