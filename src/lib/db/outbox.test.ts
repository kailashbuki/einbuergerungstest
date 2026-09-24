import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Mutation, QuestionProgress, Settings } from '@/types';
import { deleteDb } from './index';
import { defaultQuestionProgress, defaultSettings } from './schema';
import { ack, all, clear, count, drain, enqueue, enqueueAll, peek } from './outbox';

const T0 = 1_700_000_000_000;

function progressMutation(id: string, at: number, questionId = 'F001'): Mutation {
  const value: QuestionProgress = { ...defaultQuestionProgress(at), seen: 1 };
  return { kind: 'progress', id, at, questionId, value };
}

function settingsMutation(id: string, at: number): Mutation {
  const value: Settings = { ...defaultSettings(at), state: 'BW' };
  return { kind: 'settings', id, at, value };
}

beforeEach(async () => {
  await deleteDb();
});

describe('enqueue', () => {
  it('raises the count', async () => {
    expect(await count()).toBe(0);
    expect(await enqueue(progressMutation('m1', T0))).toBe(true);
    expect(await count()).toBe(1);
    expect(await enqueue(progressMutation('m2', T0 + 1))).toBe(true);
    expect(await count()).toBe(2);
  });

  it('is idempotent on a duplicate mutation id', async () => {
    expect(await enqueue(progressMutation('m1', T0))).toBe(true);
    expect(await enqueue(progressMutation('m1', T0 + 5_000, 'BW02'))).toBe(false);
    expect(await count()).toBe(1);
    // The original entry — and its queue position — is kept.
    const pending = await peek();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(progressMutation('m1', T0));
  });

  it('enqueues a batch, skipping ids already queued', async () => {
    await enqueue(progressMutation('m1', T0));
    const queued = await enqueueAll([
      progressMutation('m1', T0),
      progressMutation('m2', T0 + 1),
      progressMutation('m3', T0 + 2),
    ]);
    expect(queued).toBe(2);
    expect(await count()).toBe(3);
  });

  it('stores every mutation kind unchanged', async () => {
    const mutations: readonly Mutation[] = [
      progressMutation('a', T0),
      settingsMutation('b', T0 + 1),
      { kind: 'practiceDay', id: 'c', at: T0 + 2, day: '2025-04-01' },
      { kind: 'badge', id: 'd', at: T0 + 3, badge: 'streak-7', earnedAt: T0 },
      { kind: 'xp', id: 'e', at: T0 + 4, value: 120 },
    ];
    await enqueueAll(mutations);
    // Round-tripped exactly: the internal ordering field is never visible.
    expect(await peek()).toEqual(mutations);
  });
});

describe('peek', () => {
  it('is FIFO by `at`', async () => {
    await enqueue(progressMutation('late', T0 + 3_000));
    await enqueue(progressMutation('early', T0));
    await enqueue(progressMutation('middle', T0 + 1_000));
    expect((await peek()).map((m) => m.id)).toEqual(['early', 'middle', 'late']);
  });

  it('breaks `at` ties by insertion order, not by id', async () => {
    // Ids chosen so alphabetical order is the reverse of insertion order: if the
    // queue leaned on the primary key it would come back backwards.
    await enqueue(progressMutation('zzz', T0));
    await enqueue(progressMutation('mmm', T0));
    await enqueue(progressMutation('aaa', T0));
    expect((await peek()).map((m) => m.id)).toEqual(['zzz', 'mmm', 'aaa']);
  });

  it('honours the limit and returns everything by default', async () => {
    await enqueueAll([
      progressMutation('m1', T0),
      progressMutation('m2', T0 + 1),
      progressMutation('m3', T0 + 2),
    ]);
    expect((await peek(2)).map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(await peek(0)).toEqual([]);
    expect(await peek(99)).toHaveLength(3);
    expect(await all()).toHaveLength(3);
  });
});

describe('ack / drain', () => {
  it('lowers the count', async () => {
    await enqueueAll([progressMutation('m1', T0), progressMutation('m2', T0 + 1)]);
    expect(await ack(['m1'])).toBe(1);
    expect(await count()).toBe(1);
  });

  it('leaves the unacked remainder in order', async () => {
    await enqueueAll([
      progressMutation('m1', T0),
      progressMutation('m2', T0 + 1),
      progressMutation('m3', T0 + 2),
      progressMutation('m4', T0 + 3),
    ]);
    await drain(['m2', 'm4']);
    expect((await peek()).map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(await count()).toBe(2);
  });

  it('ignores unknown and repeated ids', async () => {
    await enqueue(progressMutation('m1', T0));
    expect(await ack(['nope'])).toBe(0);
    expect(await ack(['m1'])).toBe(1);
    expect(await ack(['m1'])).toBe(0);
    expect(await ack([])).toBe(0);
    expect(await count()).toBe(0);
  });

  it('keeps insertion order monotonic after a full drain and refill', async () => {
    await enqueueAll([progressMutation('a', T0), progressMutation('b', T0)]);
    await drain(['a', 'b']);
    await enqueueAll([progressMutation('c', T0), progressMutation('d', T0)]);
    expect((await peek()).map((m) => m.id)).toEqual(['c', 'd']);
  });
});

describe('clear', () => {
  it('empties the queue', async () => {
    await enqueueAll([progressMutation('m1', T0), progressMutation('m2', T0 + 1)]);
    await clear();
    expect(await count()).toBe(0);
    expect(await peek()).toEqual([]);
  });
});
