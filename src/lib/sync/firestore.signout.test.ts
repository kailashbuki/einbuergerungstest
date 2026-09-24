/**
 * Sign-out must not leave one account's pending mutations behind for the next
 * account to push.
 *
 * Separate file from `firestore.test.ts` because that one pins `@/lib/firebase`
 * to *unconfigured*, and `signOut()` returns immediately in that case
 * (`if (!configured) return`) — so the behaviour under test is unreachable
 * there. Here Firebase is configured but `getFirebase()` resolves to `null`,
 * which is exactly the shape of "a real project, no network": the adapter skips
 * the remote sign-out and must still clean up locally.
 *
 * The defect this guards: `src/lib/db/outbox.ts` documented that the queue "is
 * cleared on sign-out", and nothing did it. The queue is not scoped to an
 * account, so mutations queued while user A was signed in survived sign-out and
 * were pushed into whichever account signed in next — on a shared or family
 * device, that uploads one person's answer history, free-text notes and chosen
 * Bundesland into a stranger's document.
 */

import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Mutation } from '@/types';

vi.mock('@/lib/firebase', () => ({
  isFirebaseConfigured: (): boolean => true,
  // A configured project we cannot reach. `signOut` must still succeed.
  getFirebase: (): Promise<null> => Promise.resolve(null),
}));

const { createFirestoreAdapter } = await import('./firestore');
const { closeDb, deleteDb } = await import('@/lib/db');
const outbox = await import('@/lib/db/outbox');

function mutation(id: string, questionId: string): Mutation {
  return {
    id,
    at: 1000,
    kind: 'progress',
    questionId,
    value: {
      seen: 1,
      correct: 1,
      wrong: 0,
      consecutiveCorrect: 1,
      hintsUsed: 0,
      lastSeen: 1000,
      ease: 2.5,
      dueAt: 2000,
      flagged: false,
      note: 'a private note',
      updatedAt: 1000,
    },
  };
}

beforeEach(async () => {
  await closeDb();
  await deleteDb();
});

afterEach(async () => {
  await closeDb();
});

describe('signOut', () => {
  it('empties the outbox so the next account cannot inherit it', async () => {
    await outbox.enqueueAll([mutation('m1', 'F001'), mutation('m2', 'F002')]);
    expect(await outbox.count()).toBe(2);

    await createFirestoreAdapter().signOut();

    expect(await outbox.count()).toBe(0);
  });

  it('reports signed-out even though the project was unreachable', async () => {
    const adapter = createFirestoreAdapter();
    await adapter.signOut();

    // Sign-out must always succeed from the user's point of view: a user who
    // asked to be signed out must never be left holding a credential because a
    // network call failed.
    expect(adapter.status()).toBe('signed-out');
    expect(adapter.account()).toBeNull();
  });

  it('does not reject when the outbox itself cannot be cleared', async () => {
    await outbox.enqueueAll([mutation('m1', 'F001')]);
    // Simulate storage that refuses writes (Safari private mode, quota).
    const spy = vi.spyOn(outbox, 'clear').mockRejectedValue(new Error('quota exceeded'));

    // Still must not throw, and must still drop the local session.
    const adapter = createFirestoreAdapter();
    await expect(adapter.signOut()).resolves.toBeUndefined();
    expect(adapter.status()).toBe('signed-out');

    spy.mockRestore();
  });

  it('is idempotent: signing out twice is harmless', async () => {
    await outbox.enqueueAll([mutation('m1', 'F001')]);
    const adapter = createFirestoreAdapter();
    await adapter.signOut();
    await adapter.signOut();
    expect(await outbox.count()).toBe(0);
  });
});
