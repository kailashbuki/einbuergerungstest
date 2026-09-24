/**
 * Persistent-storage requests.
 *
 * By default a browser may evict IndexedDB under storage pressure, which for
 * this app means silently losing months of study progress. `navigator.storage
 * .persist()` asks the browser to exempt our origin; Chrome grants it based on
 * engagement/installation heuristics, Firefox prompts, Safari grants it for
 * installed PWAs. Everything here is feature-detected and never throws — the
 * Settings screen just shows the tri-state result and offers the export button
 * as the manual fallback when persistence is denied.
 */

/** `'unsupported'` means the browser has no Storage API at all (e.g. jsdom, old Safari). */
export type PersistState = 'granted' | 'denied' | 'unsupported';

/**
 * Feature-detect `navigator.storage` without assuming `navigator` — or any of
 * its members — actually exists. The DOM lib types these as always present; in
 * jsdom and older browsers they are not.
 */
function storageManager(): StorageManager | null {
  const nav: Navigator | undefined = globalThis.navigator;
  if (nav === undefined) return null;
  const storage: StorageManager | undefined = nav.storage;
  if (typeof storage !== 'object' || storage === null) return null;
  return storage;
}

/**
 * Ask the browser to make our storage persistent.
 *
 * Safe to call more than once; browsers treat a repeat call as a no-op when
 * already granted.
 */
export async function requestPersistentStorage(): Promise<PersistState> {
  const storage = storageManager();
  if (storage === null || typeof storage.persist !== 'function') return 'unsupported';
  try {
    return (await storage.persist()) ? 'granted' : 'denied';
  } catch (error) {
    console.warn('[persist] persist() failed', error);
    return 'denied';
  }
}

/** Whether storage is already persistent. */
export async function isPersisted(): Promise<PersistState> {
  const storage = storageManager();
  if (storage === null || typeof storage.persisted !== 'function') return 'unsupported';
  try {
    return (await storage.persisted()) ? 'granted' : 'denied';
  } catch (error) {
    console.warn('[persist] persisted() failed', error);
    return 'denied';
  }
}

export interface StorageUsage {
  readonly supported: boolean;
  readonly usage: number | null;
  readonly quota: number | null;
  /** `usage / quota` in `[0, 1]`, or `null` when either side is unknown. */
  readonly usedFraction: number | null;
}

const UNSUPPORTED_USAGE: StorageUsage = {
  supported: false,
  usage: null,
  quota: null,
  usedFraction: null,
};

/** Best-effort usage/quota. Values are deliberately coarse in every browser. */
export async function storageEstimate(): Promise<StorageUsage> {
  const storage = storageManager();
  if (storage === null || typeof storage.estimate !== 'function') return UNSUPPORTED_USAGE;
  try {
    const estimate = await storage.estimate();
    const usage = typeof estimate.usage === 'number' ? estimate.usage : null;
    const quota = typeof estimate.quota === 'number' ? estimate.quota : null;
    const usedFraction =
      usage !== null && quota !== null && quota > 0 ? Math.min(1, usage / quota) : null;
    return { supported: true, usage, quota, usedFraction };
  } catch (error) {
    console.warn('[persist] estimate() failed', error);
    return UNSUPPORTED_USAGE;
  }
}

/** Everything the Settings screen needs about durability, in one call. */
export interface PersistenceReport {
  readonly persisted: PersistState;
  readonly usage: StorageUsage;
}

export async function persistenceReport(): Promise<PersistenceReport> {
  return { persisted: await isPersisted(), usage: await storageEstimate() };
}
