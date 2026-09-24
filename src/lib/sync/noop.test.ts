import { describe, expect, it } from 'vitest';

import type { Mutation, ProgressDoc } from '@/types';
import { createNoopSyncAdapter, isNoopAdapter, noopSyncAdapter } from './noop';
import {
  describeStatus,
  isSyncAdapter,
  readSyncState,
  SYNC_ADAPTER_METHODS,
  SYNC_STATUSES,
  SyncNotConfiguredError,
} from './SyncAdapter';

const mutation: Mutation = { kind: 'xp', id: 'm1', at: 1, value: 10 };

describe('the no-op adapter', () => {
  it('satisfies the full SyncAdapter contract', () => {
    expect(isSyncAdapter(noopSyncAdapter)).toBe(true);
    for (const method of SYNC_ADAPTER_METHODS) {
      expect(typeof noopSyncAdapter[method]).toBe('function');
    }
    expect(noopSyncAdapter.name).toBe('noop');
    expect(noopSyncAdapter.configured).toBe(false);
    expect(isNoopAdapter(noopSyncAdapter)).toBe(true);
  });

  it('reports signed-out rather than an error', () => {
    expect(noopSyncAdapter.status()).toBe('signed-out');
    expect(noopSyncAdapter.account()).toBeNull();
  });

  it('resolves signIn and signOut without throwing', async () => {
    await expect(noopSyncAdapter.signIn()).resolves.toBeUndefined();
    await expect(noopSyncAdapter.signOut()).resolves.toBeUndefined();
    // Repeat calls stay harmless.
    await expect(noopSyncAdapter.signIn()).resolves.toBeUndefined();
  });

  it('pulls null and pushes without complaint', async () => {
    await expect(noopSyncAdapter.pull()).resolves.toBeNull();
    await expect(noopSyncAdapter.push([])).resolves.toBeUndefined();
    await expect(noopSyncAdapter.push([mutation, mutation])).resolves.toBeUndefined();
  });

  it('returns a callable, idempotent unsubscribe that never fires the callback', () => {
    let calls = 0;
    const unsubscribe = noopSyncAdapter.subscribe((_doc: ProgressDoc) => {
      calls += 1;
    });
    expect(typeof unsubscribe).toBe('function');
    expect(() => {
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
    expect(calls).toBe(0);
  });

  it('is stateless, so instances are interchangeable', async () => {
    const a = createNoopSyncAdapter();
    const b = createNoopSyncAdapter();
    expect(a).not.toBe(b);
    expect(a.status()).toBe(b.status());
    await a.push([mutation]);
    expect(await b.pull()).toBeNull();
  });

  it('never throws, whatever order the API is used in', async () => {
    const adapter = createNoopSyncAdapter();
    await expect(
      (async () => {
        adapter.status();
        adapter.account();
        await adapter.signOut();
        await adapter.push([mutation]);
        await adapter.pull();
        adapter.subscribe(() => {})();
        await adapter.signIn();
      })(),
    ).resolves.toBeUndefined();
  });
});

describe('SyncAdapter helpers', () => {
  it('builds a view model from an adapter', () => {
    const state = readSyncState(noopSyncAdapter, { pending: 3 });
    expect(state).toEqual({
      adapter: 'noop',
      configured: false,
      status: 'signed-out',
      account: null,
      signedIn: false,
      pending: 3,
      lastSyncAt: null,
      error: null,
    });
  });

  it('survives an adapter whose status() throws', () => {
    const broken = {
      ...createNoopSyncAdapter(),
      status(): never {
        throw new Error('kaboom');
      },
    };
    const state = readSyncState(broken);
    expect(state.status).toBe('error');
    expect(state.error).toBe('kaboom');
  });

  it('describes every status', () => {
    for (const status of SYNC_STATUSES) {
      const description = describeStatus(status);
      expect(description.i18nKey.startsWith('sync.status.')).toBe(true);
      expect(typeof description.busy).toBe('boolean');
    }
    expect(describeStatus('syncing').busy).toBe(true);
    expect(describeStatus('synced').tone).toBe('positive');
    expect(describeStatus('error').tone).toBe('danger');
  });

  it('rejects things that are not adapters', () => {
    expect(isSyncAdapter(null)).toBe(false);
    expect(isSyncAdapter({})).toBe(false);
    expect(isSyncAdapter({ ...createNoopSyncAdapter(), push: 'nope' })).toBe(false);
  });

  it('exposes a shared not-configured error type for real adapters', () => {
    const error = new SyncNotConfiguredError('firestore');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SyncNotConfiguredError');
    expect(error.message).toContain('firestore');
  });
});
