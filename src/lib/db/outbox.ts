/**
 * The pending-mutation queue.
 *
 * This app is local-first: the UI *only* ever writes to IndexedDB, and every
 * write that also needs to reach the cloud is appended here as a {@link Mutation}.
 * A sync adapter later peeks at the queue, pushes what it can, and acks the ids
 * it succeeded with. Because we own the queue rather than the adapter, its
 * behaviour is adapter-agnostic and fully unit-testable — and the app works
 * identically when no adapter is configured at all (the queue simply grows, then
 * is cleared on sign-out).
 *
 * Ordering: FIFO by `at`, ties broken by insertion order. IndexedDB index
 * ordering would break ties by primary key (the mutation id, effectively
 * random), so each record carries an internal monotonic `seq`. `peek()` strips
 * it again, so callers only ever see a plain `Mutation`.
 *
 * Idempotency: `enqueue()` is keyed on the mutation id. Enqueuing the same id
 * twice does not double-queue — which is what lets callers retry a local write
 * without bookkeeping.
 */

import type { Mutation } from '@/types';
import { openDb } from './index';
import type { OutboxRecord } from './schema';

export type { OutboxRecord } from './schema';

/** Drop the internal ordering field so consumers see exactly a `Mutation`. */
function toMutation(record: OutboxRecord): Mutation {
  const { seq: _seq, ...mutation } = record;
  return mutation;
}

function compareRecords(a: OutboxRecord, b: OutboxRecord): number {
  return a.at === b.at ? a.seq - b.seq : a.at - b.at;
}

/**
 * Append a mutation.
 *
 * @returns `true` when it was queued, `false` when an entry with that id was
 * already pending (the existing entry — and its queue position — is kept).
 */
export async function enqueue(mutation: Mutation): Promise<boolean> {
  const db = await openDb();
  const tx = db.transaction(['outbox', 'meta'], 'readwrite');
  const store = tx.objectStore('outbox');
  const existing = await store.get(mutation.id);
  if (existing !== undefined) {
    await tx.done;
    return false;
  }
  const meta = tx.objectStore('meta');
  const rawSeq = await meta.get('outboxSeq');
  const seq = (typeof rawSeq === 'number' && Number.isFinite(rawSeq) ? rawSeq : 0) + 1;
  await meta.put(seq, 'outboxSeq');
  const record: OutboxRecord = { ...mutation, seq };
  await store.put(record);
  await tx.done;
  return true;
}

/** Append several mutations, preserving their relative order. */
export async function enqueueAll(mutations: readonly Mutation[]): Promise<number> {
  let queued = 0;
  for (const mutation of mutations) {
    if (await enqueue(mutation)) queued += 1;
  }
  return queued;
}

/** The oldest pending mutations, in FIFO order. `limit` defaults to "all of them". */
export async function peek(limit = Number.POSITIVE_INFINITY): Promise<readonly Mutation[]> {
  if (limit <= 0) return [];
  const db = await openDb();
  const rows = await db.getAll('outbox');
  rows.sort(compareRecords);
  const slice = Number.isFinite(limit) ? rows.slice(0, limit) : rows;
  return slice.map(toMutation);
}

/** Everything pending, FIFO. Convenience wrapper around `peek()`. */
export async function all(): Promise<readonly Mutation[]> {
  return peek();
}

export async function count(): Promise<number> {
  const db = await openDb();
  return db.count('outbox');
}

/**
 * Remove the given mutation ids from the queue — i.e. the adapter confirmed they
 * landed remotely. Unknown ids are ignored, so acking twice is harmless.
 *
 * @returns how many entries were actually removed.
 */
export async function ack(ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const db = await openDb();
  const tx = db.transaction('outbox', 'readwrite');
  const store = tx.objectStore('outbox');
  let removed = 0;
  for (const id of ids) {
    if ((await store.get(id)) !== undefined) {
      await store.delete(id);
      removed += 1;
    }
  }
  await tx.done;
  return removed;
}

/**
 * Alias of {@link ack} — reads better at the call site that has just finished
 * flushing (`drain(ids)`), while `ack` reads better on a per-mutation ack.
 */
export const drain = ack;

/** Empty the queue. Used on sign-out and by the full reset. */
export async function clear(): Promise<void> {
  const db = await openDb();
  await db.clear('outbox');
}
