// The driver's whole job is "one adapter, one cycle at a time, never explode",
// so that is exactly what is asserted here. The Firestore adapter is replaced by
// a fake: the driver is defined against the `SyncAdapter` contract and must not
// care what is behind it.

import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Mutation, ProgressDoc, SyncAccount, SyncAdapter, SyncStatus } from '@/types';
import { closeDb, deleteDb, replaceProgressDoc } from '@/lib/db';
import { DB_VERSION } from '@/lib/db/migrations';
import { defaultProgressDoc, defaultSettings } from '@/lib/db/schema';
import { useAppStore } from '@/store';

const T0 = 1_700_000_000_000;
const ACCOUNT: SyncAccount = { uid: 'u1', email: 'a@example.com', displayName: 'A' };

/**
 * `vi.hoisted` because `vi.mock` factories run before the module body: the
 * mocks read this object at call time, so each test can flip `configured` or
 * make the adapter fail without a separate test file per case.
 */
const h = vi.hoisted(() => ({
  configured: true,
  pulls: 0,
  pushes: 0,
  factoryCalls: 0,
  account: null as SyncAccount | null,
  pushError: null as Error | null,
  /** When set, `pull` waits on it, so two cycles can be genuinely in flight at once. */
  gate: null as Promise<void> | null,
}));

vi.mock('@/lib/firebase', () => ({
  isFirebaseConfigured: (): boolean => h.configured,
  getFirebase: (): Promise<null> => Promise.resolve(null),
}));

vi.mock('./firestore', () => ({
  createFirestoreAdapter: (): SyncAdapter => {
    h.factoryCalls += 1;
    return {
      name: 'fake-firestore',
      configured: true,
      status: (): SyncStatus => (h.account === null ? 'signed-out' : 'synced'),
      account: (): SyncAccount | null => h.account,
      signIn: (): Promise<void> => Promise.resolve(),
      signOut: (): Promise<void> => Promise.resolve(),
      async pull(): Promise<ProgressDoc | null> {
        h.pulls += 1;
        if (h.gate !== null) await h.gate;
        return null;
      },
      push(_mutations: readonly Mutation[]): Promise<void> {
        h.pushes += 1;
        return h.pushError === null ? Promise.resolve() : Promise.reject(h.pushError);
      },
      subscribe: () => (): void => {},
    };
  },
}));

const { getSyncAdapter, resetSyncDriverForTests, syncInBackground, syncNow } = await import('./driver');

beforeEach(async () => {
  await closeDb();
  await deleteDb();
  resetSyncDriverForTests();
  Object.assign(h, {
    configured: true,
    pulls: 0,
    pushes: 0,
    factoryCalls: 0,
    account: ACCOUNT,
    pushError: null,
    gate: null,
  });
  await replaceProgressDoc(
    { ...defaultProgressDoc(DB_VERSION, T0), settings: { ...defaultSettings(T0), state: 'BW', onboarded: true } },
    T0,
  );
});

afterEach(async () => {
  await closeDb();
});

describe('the sync driver', () => {
  it('never touches Firebase when sync is unconfigured', async () => {
    h.configured = false;

    const adapter = await getSyncAdapter();
    const result = await syncNow();

    expect(adapter.name).toBe('noop');
    expect(h.factoryCalls).toBe(0);
    expect(result.outcome).toBe('skipped');
    expect(h.pulls).toBe(0);
  });

  it('shares one adapter instance across every call site', async () => {
    const a = await getSyncAdapter();
    const b = await getSyncAdapter();

    expect(a).toBe(b);
    // One instance means one auth subscription and one cached account.
    expect(h.factoryCalls).toBe(1);
  });

  it('syncs and refreshes the store from the merged local document', async () => {
    useAppStore.setState({ hydrated: false, settings: { ...useAppStore.getState().settings, state: null } });

    const result = await syncNow();

    expect(result.outcome).toBe('synced');
    expect(h.pushes).toBe(1);
    // reloadFromDb ran, so the UI sees what the cycle wrote.
    expect(useAppStore.getState().hydrated).toBe(true);
    expect(useAppStore.getState().settings.state).toBe('BW');
  });

  it('collapses overlapping calls into a single cycle', async () => {
    // Hold `pull` open so both calls are in flight at the same moment.
    let release!: () => void;
    h.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = syncNow();
    const second = syncNow();
    expect(first).toBe(second);

    release();
    await first;
    await second;

    // One pull, one push — not two of each racing to write the same document.
    expect(h.pulls).toBe(1);
    expect(h.pushes).toBe(1);
  });

  it('allows a fresh cycle once the previous one settled', async () => {
    await syncNow();
    await syncNow();
    expect(h.pulls).toBe(2);
  });

  it('rejects from syncNow but never from syncInBackground', async () => {
    h.pushError = new Error('boom');

    await expect(syncNow()).rejects.toThrow('boom');
    await expect(syncInBackground()).resolves.toMatchObject({ outcome: 'skipped' });
  });

  it('skips without pushing when nobody is signed in', async () => {
    h.account = null;

    const result = await syncNow();

    expect(result.outcome).toBe('skipped');
    expect(h.pushes).toBe(0);
  });
});
