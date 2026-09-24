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
import {
  DB_VERSION,
  defaultProgressDoc,
  getDbInfo,
  loadProgressDoc,
  replaceProgressDoc,
  setLastSyncAt,
  setSyncedUid,
} from '@/lib/db';
import { ack, all as allQueued, clear as clearOutbox } from '@/lib/db/outbox';
import { takeSnapshot } from '@/lib/db/snapshots';
import { mergeDocs } from './merge';

/**
 * What a cycle did, for the UI to report without having to guess:
 * - `'skipped'` — sync is unconfigured or nobody is signed in. Not an error.
 * - `'synced'` — a full pull/merge/push completed.
 * - `'account-switched'` — the document here belonged to a different account, so
 *   it was quarantined and this account's own document adopted. Nothing was
 *   pushed. See {@link runSyncCycle}.
 */
export type SyncCycleOutcome = 'skipped' | 'synced' | 'account-switched';

export interface SyncCycleResult {
  readonly outcome: SyncCycleOutcome;
  /** True when the remote already had a document (so this was a real two-way merge). */
  readonly pulled: boolean;
  /** How many queued mutations were flushed and acked. */
  readonly flushed: number;
  /** The document now in IndexedDB, or `null` when the cycle was skipped. */
  readonly doc: ProgressDoc | null;
  /**
   * Id of the quarantine snapshot taken on an `'account-switched'` cycle, or
   * `null`. Non-null means the previous account's work is recoverable from
   * Settings → Snapshots; `null` on a switch means the snapshot write failed and
   * the data is gone from this device (it is still in its own account's cloud
   * copy, which is why the switch proceeds anyway).
   */
  readonly quarantinedSnapshotId: number | null;
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
  const skipped: SyncCycleResult = {
    outcome: 'skipped',
    pulled: false,
    flushed: 0,
    doc: null,
    quarantinedSnapshotId: null,
  };
  if (!adapter.configured) return skipped;

  // Pull first, then check the account — not the other way round. `pull()` is
  // what adopts a session Firebase restored from a previous visit, so on a cold
  // page load `account()` is still null until it has run. It is safe to call
  // while signed out (resolves `null`, no throw, no write).
  const remote = await adapter.pull();
  const signedIn = adapter.account();
  if (signedIn === null) return skipped;

  const local = await loadProgressDoc();

  // ── the ownership check ───────────────────────────────────────────────────
  // Step 4 below pushes the *whole* local document, and `mergeDocs` is a
  // monotonic union with no tombstones. So if the document sitting here belongs
  // to a different account, pushing it writes a stranger's answer history, notes
  // and Bundesland into this account permanently — the cross-account leak that
  // clearing the outbox on sign-out only half fixed, because the outbox was
  // never the only copy. `meta.syncedUid` is what tells the two cases apart.
  const claimedBy = (await getDbInfo()).syncedUid;
  if (claimedBy !== null && claimedBy !== signedIn.uid) {
    // Quarantine rather than delete: the outgoing document is recoverable from
    // Settings → Snapshots, and it is also still in its own account's cloud copy.
    // Best-effort, because failing to snapshot must not force us to either push
    // the data into the wrong account or refuse to sync at all.
    let quarantinedSnapshotId: number | null = null;
    try {
      quarantinedSnapshotId = await takeSnapshot(local, 'pre-account-switch', now);
    } catch (error) {
      console.warn('[sync] could not quarantine the previous account\'s document', error);
    }

    // Adopt this account's own document, or a clean slate when it has none.
    const adopted = remote ?? defaultProgressDoc(DB_VERSION);
    await replaceProgressDoc(adopted, now);
    // Anything still queued was produced by the previous owner. Dropping it is
    // the same trade as on sign-out: a mutation is an absolute snapshot of state
    // that lives in the document we just quarantined, so nothing is destroyed
    // that the snapshot does not already hold.
    await clearOutbox();
    await setSyncedUid(signedIn.uid);
    await setLastSyncAt(now);
    return {
      outcome: 'account-switched',
      pulled: remote !== null,
      flushed: 0,
      doc: adopted,
      quarantinedSnapshotId,
    };
  }

  const merged = remote === null ? local : mergeDocs(local, remote);
  if (remote !== null) await replaceProgressDoc(merged, now);

  const queued = await allQueued();
  await adapter.push([...mutationsFromDoc(merged), ...queued]);
  const flushed = queued.length === 0 ? 0 : await ack(queued.map((m) => m.id));

  // Claim the document only now. Before the push it is not yet true that this
  // account holds a copy, and a claim written on a failed cycle would make a
  // retry look like an account switch to the very user it belongs to.
  if (claimedBy === null) await setSyncedUid(signedIn.uid);
  await setLastSyncAt(now);
  return {
    outcome: 'synced',
    pulled: remote !== null,
    flushed,
    doc: merged,
    quarantinedSnapshotId: null,
  };
}
