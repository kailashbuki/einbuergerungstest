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

// The cross-account leak. Step 4 of a cycle pushes the *whole* local document and
// `mergeDocs` is a monotonic union with no tombstones, so a document pushed into
// the wrong account can never be removed from it again. Clearing the outbox on
// sign-out fixed half of it; the document itself was the other half.
//
// The shape to keep in mind throughout: two people, one browser.
describe('runSyncCycle and account ownership', () => {
  const OTHER: SyncAccount = { uid: 'u2', email: 'b@example.com', displayName: 'B' };

  it('claims an unclaimed document for whoever signs in first', async () => {
    await seedLocal();

    await runSyncCycle(fakeAdapter(), T0 + 1_000);

    // The "I studied for three weeks before making an account" path: adopting an
    // unclaimed document is correct, and is why the guard cannot simply be
    // "refuse to push anything that was not created while signed in".
    expect((await getDbInfo()).syncedUid).toBe('u1');
  });

  it('does not claim the document when the push failed', async () => {
    await seedLocal();
    const adapter = fakeAdapter({ pushError: new Error('offline') });

    await expect(runSyncCycle(adapter, T0 + 1_000)).rejects.toThrow('offline');

    // A claim written on a failed cycle would make the owner's own retry look
    // like an account switch and quarantine their work.
    expect((await getDbInfo()).syncedUid).toBeNull();
  });

  it('never pushes one account\'s document into another account', async () => {
    const mine = await seedLocal();
    await runSyncCycle(fakeAdapter(), T0 + 1_000);

    // Same browser, second person signs in. Their account is empty.
    const theirs = fakeAdapter({ account: OTHER, remote: null });
    const result = await runSyncCycle(theirs, T0 + 2_000);

    expect(result.outcome).toBe('account-switched');
    // The assertion that matters: nothing left the device for u2's account. A
    // single push here is the leak, permanently.
    expect(theirs.pushed).toHaveLength(0);
    const after = await loadProgressDoc();
    expect(after.progress['F001']).toBeUndefined();
    expect(after.xp).toBe(0);
    expect(after.settings.state).toBeNull();
    // ...and it is u1's document that is gone from the active slot, not merely
    // hidden: `mine` must not be recoverable by reading the document back.
    expect(after.progress).not.toEqual(mine.progress);
  });

  it('quarantines the previous account\'s work instead of destroying it', async () => {
    await seedLocal();
    await runSyncCycle(fakeAdapter(), T0 + 1_000);

    const result = await runSyncCycle(fakeAdapter({ account: OTHER }), T0 + 2_000);

    // Recoverable from Settings → Snapshots. Without this the safe behaviour
    // would be indistinguishable from data loss for the first user.
    expect(result.quarantinedSnapshotId).not.toBeNull();
    const { getSnapshot, listSnapshots } = await import('@/lib/db/snapshots');
    // Listed under its own reason, so the Settings UI can label it rather than
    // presenting a mystery restore point.
    const meta = (await listSnapshots()).find((s) => s.reason === 'pre-account-switch');
    expect(meta?.id).toBe(result.quarantinedSnapshotId);
    // And the contents really are u1's, not an empty placeholder.
    const doc = await getSnapshot(result.quarantinedSnapshotId ?? -1);
    expect(doc?.progress['F001']?.correct).toBe(3);
    expect(doc?.xp).toBe(50);
    expect(doc?.settings.state).toBe('BW');
  });

  it('adopts the second account\'s own cloud document when it has one', async () => {
    await seedLocal();
    await runSyncCycle(fakeAdapter(), T0 + 1_000);

    const remote: ProgressDoc = {
      ...defaultProgressDoc(DB_VERSION, T0),
      progress: { F002: { ...defaultQuestionProgress(T0), seen: 9, correct: 9, updatedAt: T0 } },
      xp: 7,
      updatedAt: T0,
    };
    const result = await runSyncCycle(fakeAdapter({ account: OTHER, remote }), T0 + 2_000);

    expect(result.outcome).toBe('account-switched');
    const after = await loadProgressDoc();
    expect(after.progress['F002']?.correct).toBe(9);
    expect(after.xp).toBe(7);
    // Not merged with u1's — adopted instead. A merge here is the leak in the
    // other direction: u1's answers would show up on u2's screen.
    expect(after.progress['F001']).toBeUndefined();
  });

  it('drops the previous owner\'s queued mutations', async () => {
    await seedLocal();
    await runSyncCycle(fakeAdapter(), T0 + 1_000);
    await enqueueAll([
      { kind: 'xp', id: 'q1', at: T0 + 1_500, value: 999 },
    ]);
    expect(await outboxCount()).toBe(1);

    await runSyncCycle(fakeAdapter({ account: OTHER }), T0 + 2_000);

    // Queued mutations carry no uid, so anything left here would be flushed into
    // u2's account on its next cycle.
    expect(await outboxCount()).toBe(0);
  });

  it('lets the rightful owner keep syncing after a switch away and back', async () => {
    await seedLocal();
    await runSyncCycle(fakeAdapter(), T0 + 1_000);
    await runSyncCycle(fakeAdapter({ account: OTHER }), T0 + 2_000);

    // u1 signs back in. Their work is in their own cloud document, which is what
    // makes the quarantine safe rather than merely non-destructive.
    const mineAgain: ProgressDoc = {
      ...defaultProgressDoc(DB_VERSION, T0),
      progress: { F001: { ...defaultQuestionProgress(T0), seen: 3, correct: 3, updatedAt: T0 } },
      xp: 50,
      updatedAt: T0,
    };
    const back = fakeAdapter({ account: ACCOUNT, remote: mineAgain });
    const result = await runSyncCycle(back, T0 + 3_000);

    expect(result.outcome).toBe('account-switched');
    expect((await getDbInfo()).syncedUid).toBe('u1');
    expect((await loadProgressDoc()).progress['F001']?.correct).toBe(3);

    // And the cycle after that is an ordinary one — the guard must not leave the
    // device stuck switching for ever.
    const settled = await runSyncCycle(back, T0 + 4_000);
    expect(settled.outcome).toBe('synced');
    expect(back.pushed).toHaveLength(1);
  });
});
