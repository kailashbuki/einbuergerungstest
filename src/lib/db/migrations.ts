/**
 * Versioned IndexedDB migrations.
 *
 * Every schema change is an **explicit, named migration function** in
 * {@link MIGRATIONS}, ordered by `version`. Opening the database runs every
 * migration whose version is `> oldVersion` and `<= newVersion`, in order, so an
 * upgrade from *any* older version reaches the current schema by replaying the
 * same steps a user upgrading one release at a time would have run. There is no
 * "recreate the database" escape hatch: a migration must never drop user data.
 *
 * Adding a migration
 * ------------------
 * 1. Append a new entry to `MIGRATIONS` with the next `version`.
 * 2. Backfill defaults for every existing record it touches.
 * 3. Add a case to `migrations.test.ts` that starts at the *previous* version
 *    with real records and asserts nothing is lost.
 *
 * History
 * -------
 * - **v1 `initial-schema`** — the first shipped schema. `progress` records held
 *   only counters plus a bare `note: string`; there was no spaced-repetition
 *   data. `sessions`/`mocks` had no `state` field and no indexes, because the
 *   very first build supported a single state at a time.
 * - **v2 `progress-spaced-repetition`** — introduces SM-2-lite. Adds `ease`,
 *   `dueAt` and `flagged` to every existing `progress` record, backfilling
 *   `ease = 2.5`, `dueAt = lastSeen` (so previously-seen questions surface
 *   immediately rather than never) and `flagged = false`. `note` is preserved
 *   verbatim.
 * - **v3 `sync-and-snapshots`** — adds the `outbox` and `snapshots` stores,
 *   adds the `by-state` / `by-finishedAt` indexes to `sessions` and `mocks`,
 *   and backfills `state` on legacy session/mock records (inferred from the
 *   state-prefixed question ids they contain, else from the saved settings,
 *   else a documented fallback — a record is never dropped for lacking it).
 */

import type { IDBPDatabase, IDBPTransaction, StoreNames } from 'idb';
import type { StateCode } from '@/types';
import {
  coerceMockResult,
  coerceQuestionProgress,
  coerceSessionResult,
  FALLBACK_STATE,
  SETTINGS_KEY,
  type EbtDBSchema,
} from './schema';
import { isStateCode } from '@/data/states';

/** The upgrade transaction handed to every migration. */
export type UpgradeTransaction = IDBPTransaction<
  EbtDBSchema,
  StoreNames<EbtDBSchema>[],
  'versionchange'
>;

export interface Migration {
  /** The schema version this migration produces. */
  readonly version: number;
  /** Stable, human-readable name. Referenced by tests and logs. */
  readonly name: string;
  /** Describe what changed and how existing records are backfilled. */
  readonly description: string;
  migrate(db: IDBPDatabase<EbtDBSchema>, tx: UpgradeTransaction): Promise<void>;
}

/* ───────────────────────────── migration 1 ──────────────────────────── */

const initialSchema: Migration = {
  version: 1,
  name: 'initial-schema',
  description:
    'Create the original stores: meta, settings, progress, sessions, mocks, practiceDays, badges. ' +
    'No indexes; progress records carry counters and a bare note.',
  async migrate(db) {
    db.createObjectStore('meta');
    db.createObjectStore('settings');
    db.createObjectStore('progress');
    db.createObjectStore('sessions', { keyPath: 'id' });
    db.createObjectStore('mocks', { keyPath: 'id' });
    db.createObjectStore('practiceDays');
    db.createObjectStore('badges');
    await Promise.resolve();
  },
};

/* ───────────────────────────── migration 2 ──────────────────────────── */

const progressSpacedRepetition: Migration = {
  version: 2,
  name: 'progress-spaced-repetition',
  description:
    'Add ease/dueAt/flagged to every progress record. ease defaults to 2.5, dueAt backfills from ' +
    'lastSeen so seen-but-unscheduled questions become due immediately, flagged defaults to false. ' +
    'All v1 counters and the note are preserved verbatim.',
  async migrate(_db, tx) {
    const store = tx.objectStore('progress');
    let cursor = await store.openCursor();
    while (cursor) {
      // Read as `unknown`: on disk this is still a v1 record.
      const legacy: unknown = cursor.value;
      const upgraded = coerceQuestionProgress(legacy);
      if (upgraded === null) {
        // Not an object at all — unrecoverable garbage, but we still must not
        // leave a value the typed API would choke on.
        await cursor.delete();
      } else {
        await cursor.update(upgraded);
      }
      cursor = await cursor.continue();
    }
  },
};

/* ───────────────────────────── migration 3 ──────────────────────────── */

const syncAndSnapshots: Migration = {
  version: 3,
  name: 'sync-and-snapshots',
  description:
    'Add the snapshots and outbox stores, add by-state/by-finishedAt indexes to sessions and mocks, ' +
    'and backfill a state on legacy session/mock records so the new indexes are complete.',
  async migrate(db, tx) {
    if (!db.objectStoreNames.contains('snapshots')) {
      db.createObjectStore('snapshots', { autoIncrement: true });
    }
    if (!db.objectStoreNames.contains('outbox')) {
      db.createObjectStore('outbox', { keyPath: 'id' });
    }

    // The fallback state for records we cannot attribute from question ids.
    const settingsRaw: unknown = await tx.objectStore('settings').get(SETTINGS_KEY);
    let fallbackState: StateCode = FALLBACK_STATE;
    if (typeof settingsRaw === 'object' && settingsRaw !== null) {
      const candidate = (settingsRaw as { state?: unknown }).state;
      if (typeof candidate === 'string' && isStateCode(candidate)) fallbackState = candidate;
    }

    const sessions = tx.objectStore('sessions');
    if (!sessions.indexNames.contains('by-state')) {
      sessions.createIndex('by-state', 'state');
    }
    if (!sessions.indexNames.contains('by-finishedAt')) {
      sessions.createIndex('by-finishedAt', 'finishedAt');
    }
    let sessionCursor = await sessions.openCursor();
    while (sessionCursor) {
      const legacy: unknown = sessionCursor.value;
      const upgraded = coerceSessionResult(legacy, fallbackState);
      if (upgraded === null) {
        await sessionCursor.delete();
      } else {
        await sessionCursor.update(upgraded);
      }
      sessionCursor = await sessionCursor.continue();
    }

    const mocks = tx.objectStore('mocks');
    if (!mocks.indexNames.contains('by-state')) {
      mocks.createIndex('by-state', 'state');
    }
    if (!mocks.indexNames.contains('by-finishedAt')) {
      mocks.createIndex('by-finishedAt', 'finishedAt');
    }
    let mockCursor = await mocks.openCursor();
    while (mockCursor) {
      const legacy: unknown = mockCursor.value;
      const upgraded = coerceMockResult(legacy, fallbackState);
      if (upgraded === null) {
        await mockCursor.delete();
      } else {
        await mockCursor.update(upgraded);
      }
      mockCursor = await mockCursor.continue();
    }
  },
};

/* ────────────────────────────── the ladder ──────────────────────────── */

/** Ordered, append-only. Index N is version N + 1. */
export const MIGRATIONS: readonly Migration[] = [
  initialSchema,
  progressSpacedRepetition,
  syncAndSnapshots,
];

/** The schema version the current build writes. Derived, never hand-maintained. */
export const DB_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/** Migrations that must run to get from `oldVersion` to `newVersion`, in order. */
export function migrationsFor(oldVersion: number, newVersion: number): readonly Migration[] {
  return MIGRATIONS.filter((m) => m.version > oldVersion && m.version <= newVersion).slice().sort(
    (a, b) => a.version - b.version,
  );
}

/**
 * Replay every pending migration inside the upgrade transaction.
 *
 * Only IndexedDB work is awaited in here: awaiting anything else (a fetch, a
 * timer) would let the `versionchange` transaction auto-commit mid-migration.
 */
export async function runMigrations(
  db: IDBPDatabase<EbtDBSchema>,
  tx: UpgradeTransaction,
  oldVersion: number,
  newVersion: number,
): Promise<readonly string[]> {
  const applied: string[] = [];
  for (const migration of migrationsFor(oldVersion, newVersion)) {
    await migration.migrate(db, tx);
    applied.push(migration.name);
  }
  return applied;
}

/** Sanity check used by the tests: versions must be 1..N with no gaps or dupes. */
export function migrationLadderIsSane(): boolean {
  return MIGRATIONS.every((m, i) => m.version === i + 1 && m.name.length > 0);
}
