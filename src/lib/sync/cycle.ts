// The sync cycle: the one place that actually moves data between IndexedDB and
// the cloud. Everything above it (the settings panel, the store) is local-first
// and never talks to an adapter directly.
//
// One pass is always pull → merge → write local → push → ack, in that order:
//
//   1. `pull()` the remote document (may be `null` on a brand-new account).
//   2. `mergeDocs(local, remote)` — never overwrite either side. This is the
//      step that makes "first sign-in with existing local progress" safe.
//   3. Write the merged document back to IndexedDB, which stays the source of
//      truth for the UI.
//   4. Push the merged document *plus* every queued outbox mutation, so
//      progress that predates sign-in (and therefore never went through the
//      outbox) still reaches the cloud.
//   5. Ack the queued mutations only after the push resolved, so a failed push
//      leaves them queued for the next attempt rather than dropping them.
//
// The push in step 4 is a full-document upload rather than a delta. It is a few
// KB, it is idempotent under `mergeDocs`, and it removes a whole class of bug
// where the cloud silently lags behind because some mutation never made it into
// the outbox. Bandwidth is not the scarce resource here; correctness is.

import type { Mutation, ProgressDoc, SyncAdapter } from '@/types';
import { loadProgressDoc, replaceProgressDoc, setLastSyncAt } from '@/lib/db';
import { ack, all as allQueued } from '@/lib/db/outbox';
import { mergeDocs } from './merge';

/**
 * What a cycle did, for the UI to report without having to guess:
 * - `'skipped'` — sync is unconfigured or nobody is signed in. Not an error.
 * - `'synced'` — a full pull/merge/push completed.
 */
export type SyncCycleOutcome = 'skipped' | 'synced';

export interface SyncCycleResult {
  readonly outcome: SyncCycleOutcome;
  /** True when the remote already had a document (so this was a real two-way merge). */
  readonly pulled: boolean;
  /** How many queued mutations were flushed and acked. */
  readonly flushed: number;
  /** The document now in IndexedDB, or `null` when the cycle was skipped. */
  readonly doc: ProgressDoc | null;
}

/**
 * Express a whole document as the mutation list that would reproduce it.
 *
 * Exported for tests: the property that matters is that pushing this list into
 * an empty remote yields the same document back, and pushing it into a remote
 * that already has other devices' work merges rather than clobbers.
 *
 * Ids are stable and namespaced (`doc:*`) so repeated cycles produce identical
 * lists — these never enter the outbox, they exist only to build one overlay.
 */
export function mutationsFromDoc(doc: ProgressDoc): Mutation[] {
  const out: Mutation[] = [
    { kind: 'settings', id: 'doc:settings', at: doc.settings.updatedAt, value: doc.settings },
    { kind: 'xp', id: 'doc:xp', at: doc.updatedAt, value: doc.xp },
  ];
  for (const [questionId, value] of Object.entries(doc.progress)) {
    out.push({ kind: 'progress', id: `doc:progress:${questionId}`, at: value.updatedAt, questionId, value });
  }
  for (const session of doc.sessions) {
    out.push({ kind: 'session', id: `doc:session:${session.id}`, at: session.finishedAt, value: session });
  }
  for (const mock of doc.mocks) {
    out.push({ kind: 'mock', id: `doc:mock:${mock.id}`, at: mock.finishedAt, value: mock });
  }
  for (const day of Object.keys(doc.practiceDays)) {
    out.push({ kind: 'practiceDay', id: `doc:day:${day}`, at: doc.updatedAt, day });
  }
  for (const [badge, earnedAt] of Object.entries(doc.badges)) {
    out.push({ kind: 'badge', id: `doc:badge:${badge}`, at: earnedAt, badge, earnedAt });
  }
  return out;
}

/**
 * Run one full sync pass. Safe to call unconditionally: with an unconfigured
 * adapter or nobody signed in it resolves to `'skipped'` without touching the
 * database or the network.
 *
 * Throws only what the adapter throws (a `SyncError` from the Firestore
 * adapter), so callers can surface a message; the local document is never left
 * half-written, because the local write happens before the push.
 */
export async function runSyncCycle(adapter: SyncAdapter, now = Date.now()): Promise<SyncCycleResult> {
  const skipped: SyncCycleResult = { outcome: 'skipped', pulled: false, flushed: 0, doc: null };
  if (!adapter.configured) return skipped;

  // Pull first, then check the account — not the other way round. `pull()` is
  // what adopts a session Firebase restored from a previous visit, so on a cold
  // page load `account()` is still null until it has run. It is safe to call
  // while signed out (resolves `null`, no throw, no write).
  const remote = await adapter.pull();
  if (adapter.account() === null) return skipped;

  const local = await loadProgressDoc();
  const merged = remote === null ? local : mergeDocs(local, remote);
  if (remote !== null) await replaceProgressDoc(merged, now);

  const queued = await allQueued();
  await adapter.push([...mutationsFromDoc(merged), ...queued]);
  const flushed = queued.length === 0 ? 0 : await ack(queued.map((m) => m.id));

  await setLastSyncAt(now);
  return { outcome: 'synced', pulled: remote !== null, flushed, doc: merged };
}
