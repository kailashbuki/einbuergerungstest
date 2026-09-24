/**
 * Automatic progress snapshots.
 *
 * A snapshot is a full copy of the `ProgressDoc` at a point in time. One is taken
 * after every finished session, and the ten most recent are retained — enough to
 * undo a bad import, a mis-tapped reset or a sync that went sideways, while
 * staying far inside any realistic storage quota (the document is a few hundred
 * counters, not media).
 *
 * Restore is itself undoable: `restoreSnapshot()` snapshots the *current* state
 * before overwriting it, so the user can always get back to where they were.
 */

import type { ProgressDoc, StateCode } from '@/types';
import { loadProgressDoc, openDb, replaceProgressDoc } from './index';
import type { SnapshotReason, StoredSnapshot } from './schema';

export type { SnapshotReason, StoredSnapshot } from './schema';

/** How many snapshots are kept. Older ones are pruned on every write. */
export const MAX_SNAPSHOTS = 10;

/** What the Settings UI needs to render the snapshot list — without loading every doc. */
export interface SnapshotMeta {
  readonly id: number;
  readonly at: number;
  readonly reason: SnapshotReason;
  /** Number of questions with progress in that snapshot. */
  readonly questionCount: number;
  /** The state selected at the time, or `null` if onboarding had not finished. */
  readonly state: StateCode | null;
  readonly sessionCount: number;
  readonly xp: number;
}

function metaOf(id: number, row: StoredSnapshot): SnapshotMeta {
  const doc = row.doc;
  return {
    id,
    at: row.at,
    reason: row.reason,
    questionCount: Object.keys(doc.progress).length,
    state: doc.settings.state,
    sessionCount: doc.sessions.length,
    xp: doc.xp,
  };
}

/**
 * Take a snapshot and prune back to {@link MAX_SNAPSHOTS}.
 *
 * Keys are auto-incremented, so they are monotonic even when two snapshots land
 * in the same millisecond — ordering never depends on the clock.
 */
export async function takeSnapshot(
  doc: ProgressDoc,
  reason: SnapshotReason = 'auto',
  at = Date.now(),
): Promise<number> {
  const db = await openDb();
  const tx = db.transaction('snapshots', 'readwrite');
  const store = tx.objectStore('snapshots');
  const id = await store.add({ at, reason, doc });

  // Prune oldest-first. Keys ascend with insertion order, so the first
  // `total - MAX_SNAPSHOTS` keys are exactly the ones to drop.
  const keys = await store.getAllKeys();
  const excess = keys.length - MAX_SNAPSHOTS;
  for (let i = 0; i < excess; i += 1) {
    const key = keys[i];
    if (key !== undefined) await store.delete(key);
  }

  await tx.done;
  return id;
}

/** Snapshot metadata, newest first. */
export async function listSnapshots(): Promise<readonly SnapshotMeta[]> {
  const db = await openDb();
  const out: SnapshotMeta[] = [];
  try {
    const tx = db.transaction('snapshots', 'readonly');
    let cursor = await tx.objectStore('snapshots').openCursor(null, 'prev');
    while (cursor) {
      out.push(metaOf(cursor.key, cursor.value));
      cursor = await cursor.continue();
    }
    await tx.done;
  } catch (error) {
    console.warn('[snapshots] listing failed', error);
    return [];
  }
  return out;
}

export async function countSnapshots(): Promise<number> {
  const db = await openDb();
  return db.count('snapshots');
}

/** The document stored in a snapshot, or `null` when the id is unknown. */
export async function getSnapshot(id: number): Promise<ProgressDoc | null> {
  const db = await openDb();
  const row = await db.get('snapshots', id);
  return row === undefined ? null : row.doc;
}

export type RestoreResult =
  | { readonly ok: true; readonly doc: ProgressDoc; readonly safetyId: number }
  | { readonly ok: false; readonly reason: 'not-found' };

/**
 * Replace the current document with a snapshot.
 *
 * Order matters: the target document is read *first*, then the pre-restore
 * safety snapshot is written (which may prune the very snapshot we are
 * restoring), then the document is replaced. So restoring the oldest snapshot
 * still works, and is still undoable.
 */
export async function restoreSnapshot(id: number, at = Date.now()): Promise<RestoreResult> {
  const target = await getSnapshot(id);
  if (target === null) return { ok: false, reason: 'not-found' };

  const current = await loadProgressDoc();
  const safetyId = await takeSnapshot(current, 'pre-restore', at);

  await replaceProgressDoc(target, at);
  return { ok: true, doc: target, safetyId };
}

/** Drop every snapshot. Part of the full reset; not exposed on its own in the UI. */
export async function clearSnapshots(): Promise<void> {
  const db = await openDb();
  await db.clear('snapshots');
}
