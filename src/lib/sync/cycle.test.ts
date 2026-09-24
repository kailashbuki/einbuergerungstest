// `runSyncCycle` is the only code path that can lose a user's progress, so the
// cases below are written around the two ways that happens: a merge that drops
// one side, and an outbox ack that fires for a push that never landed.
//
// The adapter is a fake rather than a mock of Firestore: the cycle is defined
// purely against the `SyncAdapter` contract, and what needs asserting is what it
// hands the adapter and what it writes back locally — not Firestore's wire
// behaviour, which is covered by inspection in `firestore.test.ts`.

import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Mutation, ProgressDoc, SyncAccount, SyncAdapter, SyncStatus } from '@/types';
import { closeDb, deleteDb, getDbInfo, loadProgressDoc, replaceProgressDoc } from '@/lib/db';
import { count as outboxCount, enqueueAll } from '@/lib/db/outbox';
import { DB_VERSION } from '@/lib/db/migrations';
import { defaultProgressDoc, defaultQuestionProgress, defaultSettings } from '@/lib/db/schema';
import { mutationsFromDoc, runSyncCycle } from './cycle';

const T0 = 1_700_000_000_000;
const ACCOUNT: SyncAccount = { uid: 'u1', email: 'a@example.com', displayName: 'A' };

interface FakeOptions {
  readonly configured?: boolean;
  readonly account?: SyncAccount | null;
  readonly remote?: ProgressDoc | null;
  /** Throw from `push`, as the real adapter does when signed out or when the remote doc is unwritable. */
  readonly pushError?: Error;
}

interface FakeAdapter extends SyncAdapter {
  readonly pushed: Mutation[][];
  pulls: number;
}

function fakeAdapter(options: FakeOptions = {}): FakeAdapter {
  const { configured = true, account = ACCOUNT, remote = null, pushError } = options;
  const pushed: Mutation[][] = [];
  return {
    name: 'fake',
    configured,
    pulls: 0,
    pushed,
    status(): SyncStatus {
      return account === null ? 'signed-out' : 'synced';
    },
    account(): SyncAccount | null {
      return configured ? account : null;
    },
    signIn: (): Promise<void> => Promise.resolve(),
    signOut: (): Promise<void> => Promise.resolve(),
    pull(): Promise<ProgressDoc | null> {
      this.pulls += 1;
      return Promise.resolve(configured && account !== null ? remote : null);
    },
    push(mutations: readonly Mutation[]): Promise<void> {
      if (pushError !== undefined) return Promise.reject(pushError);
      pushed.push([...mutations]);
      return Promise.resolve();
    },
    subscribe: () => (): void => {},
  };
}

/** Local progress that predates sign-in, so it never went through the outbox. */
async function seedLocal(): Promise<ProgressDoc> {
  const doc: ProgressDoc = {
    ...defaultProgressDoc(DB_VERSION, T0),
    settings: { ...defaultSettings(T0), state: 'BW', onboarded: true },
    progress: {
      F001: { ...defaultQuestionProgress(T0), seen: 3, correct: 3, consecutiveCorrect: 3, updatedAt: T0 },
    },
    practiceDays: { '2026-05-01': true },
    badges: { 'first-session': T0 },
    xp: 50,
    updatedAt: T0,
  };
  await replaceProgressDoc(doc, T0);
  return doc;
}

beforeEach(async () => {
  await closeDb();
  await deleteDb();
});

afterEach(async () => {
  await closeDb();
});

describe('mutationsFromDoc', () => {
  it('covers every field of the document, with unique ids', async () => {
    const doc = await seedLocal();
    const mutations = mutationsFromDoc(doc);
    const kinds = new Set(mutations.map((m) => m.kind));
    expect(kinds).toEqual(new Set(['settings', 'xp', 'progress', 'practiceDay', 'badge']));
    expect(new Set(mutations.map((m) => m.id)).size).toBe(mutations.length);
  });

  it('is deterministic, so repeated cycles produce identical overlays', async () => {
    const doc = await seedLocal();
    expect(mutationsFromDoc(doc)).toEqual(mutationsFromDoc(doc));
  });
});

describe('runSyncCycle', () => {
  it('skips silently when sync is unconfigured — no pull, no push, no local write', async () => {
    const before = await seedLocal();
    const adapter = fakeAdapter({ configured: false });

    const result = await runSyncCycle(adapter);

    expect(result.outcome).toBe('skipped');
    expect(adapter.pulls).toBe(0);
    expect(adapter.pushed).toHaveLength(0);
    expect((await loadProgressDoc()).progress).toEqual(before.progress);
    expect((await getDbInfo()).lastSyncAt).toBeNull();
  });

  it('skips when nobody is signed in, but still pulls first to adopt a restored session', async () => {
    await seedLocal();
    const adapter = fakeAdapter({ account: null });

    const result = await runSyncCycle(adapter);

    expect(result.outcome).toBe('skipped');
    // The pull is what makes a session Firebase restored on page load visible.
    expect(adapter.pulls).toBe(1);
    expect(adapter.pushed).toHaveLength(0);
  });

  it('uploads pre-sign-in local progress even though it never entered the outbox', async () => {
    const local = await seedLocal();
    const adapter = fakeAdapter({ remote: null });

    const result = await runSyncCycle(adapter, T0 + 5_000);

    expect(result.outcome).toBe('synced');
    expect(result.pulled).toBe(false);
    expect(adapter.pushed).toHaveLength(1);
    const pushedProgress = adapter.pushed[0]?.filter((m) => m.kind === 'progress') ?? [];
    expect(pushedProgress).toHaveLength(1);
    expect(pushedProgress[0]).toMatchObject({ questionId: 'F001', value: local.progress['F001'] });
    expect((await getDbInfo()).lastSyncAt).toBe(T0 + 5_000);
  });

  it('merges the cloud copy into the local one rather than replacing it', async () => {
    await seedLocal();
    // A second device answered a different question and earned more XP.
    const remote: ProgressDoc = {
      ...defaultProgressDoc(DB_VERSION, T0),
      settings: { ...defaultSettings(T0 - 1), state: 'BW', onboarded: true },
      progress: {
        F002: { ...defaultQuestionProgress(T0 + 1), seen: 2, correct: 2, consecutiveCorrect: 2, updatedAt: T0 + 1 },
      },
      practiceDays: { '2026-05-02': true },
      xp: 90,
      updatedAt: T0 + 1,
    };
    const adapter = fakeAdapter({ remote });

    const result = await runSyncCycle(adapter, T0 + 5_000);

    expect(result.pulled).toBe(true);
    const merged = await loadProgressDoc();
    // Neither side lost anything.
    expect(Object.keys(merged.progress).sort()).toEqual(['F001', 'F002']);
    expect(merged.practiceDays).toEqual({ '2026-05-01': true, '2026-05-02': true });
    expect(merged.xp).toBe(90);
    expect(merged.badges['first-session']).toBe(T0);
    // And what goes back up is the merged whole, so the cloud converges too.
    const pushedIds = (adapter.pushed[0] ?? []).filter((m) => m.kind === 'progress').map((m) => m.questionId);
    expect(pushedIds.sort()).toEqual(['F001', 'F002']);
  });

  it('flushes and acks queued mutations, but only after the push resolved', async () => {
    await seedLocal();
    const queued: Mutation[] = [
      { kind: 'xp', id: 'q1', at: T0 + 10, value: 75 },
      { kind: 'practiceDay', id: 'q2', at: T0 + 11, day: '2026-05-03' },
    ];
    await enqueueAll(queued);
    expect(await outboxCount()).toBe(2);

    const adapter = fakeAdapter();
    const result = await runSyncCycle(adapter, T0 + 5_000);

    expect(result.flushed).toBe(2);
    expect(await outboxCount()).toBe(0);
    const ids = (adapter.pushed[0] ?? []).map((m) => m.id);
    expect(ids).toContain('q1');
    expect(ids).toContain('q2');
  });

  it('keeps queued mutations when the push fails, so nothing is silently dropped', async () => {
    await seedLocal();
    await enqueueAll([{ kind: 'xp', id: 'q1', at: T0 + 10, value: 75 }]);

    const adapter = fakeAdapter({ pushError: new Error('signed-out') });

    await expect(runSyncCycle(adapter, T0 + 5_000)).rejects.toThrow('signed-out');
    // Still queued for the next attempt, and no misleading "last synced" time.
    expect(await outboxCount()).toBe(1);
    expect((await getDbInfo()).lastSyncAt).toBeNull();
  });

  it('is idempotent: a second pass over unchanged state changes nothing', async () => {
    await seedLocal();
    const adapter = fakeAdapter();

    await runSyncCycle(adapter, T0 + 5_000);
    const afterFirst = await loadProgressDoc();
    await runSyncCycle(adapter, T0 + 6_000);
    const afterSecond = await loadProgressDoc();

    expect(afterSecond.progress).toEqual(afterFirst.progress);
    expect(afterSecond.xp).toBe(afterFirst.xp);
    expect(adapter.pushed[1]).toEqual(adapter.pushed[0]);
  });
});
