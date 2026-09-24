// The application-level entry point for sync. Everything that wants to sync
// calls `syncNow()`; nothing else constructs an adapter.
//
// Two jobs, both of which go wrong if each caller does them itself:
//
//  1. **One adapter for the whole app.** The Firestore adapter holds the auth
//     subscription, the cached account and the live snapshot listeners, so two
//     instances would disagree about whether the user is signed in.
//  2. **One cycle at a time.** Concurrent cycles would both pull, both merge,
//     and race to write the same local document. Overlapping callers share the
//     in-flight promise instead.
//
// `firebase/*` is still only ever reached through the dynamic `import()` below,
// so importing this module does not pull ~200KB of Firebase into the app shell.

import type { SyncAdapter } from '@/types';
import { isFirebaseConfigured } from '@/lib/firebase';
import { useAppStore } from '@/store';
import { noopSyncAdapter } from './noop';
import { runSyncCycle, type SyncCycleResult } from './cycle';

const SKIPPED: SyncCycleResult = {
  outcome: 'skipped',
  pulled: false,
  flushed: 0,
  doc: null,
  quarantinedSnapshotId: null,
};

let adapterPromise: Promise<SyncAdapter> | null = null;
let inFlight: Promise<SyncCycleResult> | null = null;

/**
 * The shared adapter: the real Firestore one when configured, otherwise the
 * no-op. Falls back to the no-op rather than throwing if the chunk fails to
 * load, so a flaky network degrades to offline-only instead of breaking the UI.
 */
export function getSyncAdapter(): Promise<SyncAdapter> {
  adapterPromise ??= (async () => {
    if (!isFirebaseConfigured()) return noopSyncAdapter;
    try {
      const { createFirestoreAdapter } = await import('./firestore');
      return createFirestoreAdapter();
    } catch (err) {
      console.warn('[sync] could not load the Firestore adapter; staying offline-only', err);
      adapterPromise = null; // let a later attempt retry the chunk
      return noopSyncAdapter;
    }
  })();
  return adapterPromise;
}

/**
 * Run one sync pass and refresh the in-memory store from the merged result, so
 * the whole UI (readiness score, heatmap, streak) reflects the other device's
 * work immediately.
 *
 * Safe and cheap to call unconditionally — unconfigured or signed out, it
 * resolves to `'skipped'` without a network round trip. Rejects only when the
 * adapter rejects; queued mutations stay queued in that case.
 */
export function syncNow(): Promise<SyncCycleResult> {
  inFlight ??= (async () => {
    try {
      const adapter = await getSyncAdapter();
      if (!adapter.configured) return SKIPPED;
      const result = await runSyncCycle(adapter);
      // `'account-switched'` replaces the local document wholesale, so it needs
      // the reload at least as badly as `'synced'` does: skipping it would leave
      // the readiness score, heatmap and Bundesland of the *previous* account on
      // screen for the new one — the leak the switch exists to prevent, just via
      // the Zustand cache instead of the database.
      if (result.outcome !== 'skipped') await useAppStore.getState().reloadFromDb();
      return result;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Same as {@link syncNow} but never rejects — for background triggers (page
 * load, coming back online) that the user did not ask for and must not be
 * interrupted by. Errors are logged; the panel in Settings shows the status.
 */
export async function syncInBackground(): Promise<SyncCycleResult> {
  try {
    return await syncNow();
  } catch (err) {
    console.warn('[sync] background sync failed; will retry on the next trigger', err);
    return SKIPPED;
  }
}

/** Test seam: drop the memoised adapter and any in-flight cycle. */
export function resetSyncDriverForTests(): void {
  adapterPromise = null;
  inFlight = null;
}
