/**
 * Shared surface around the `SyncAdapter` interface.
 *
 * The interface itself lives in `@/types` so the storage, sync and UI layers can
 * be built independently against one contract. This module is deliberately thin:
 * it re-exports the contract from a sync-shaped path and adds the few pure
 * helpers both the UI and the real adapter need, so nobody has to duplicate them.
 *
 * Adapters live next to this file:
 * - `./noop.ts` — always available; used whenever Firebase is unconfigured.
 * - `./firestore.ts` — owned by the sync workstream.
 */

import type { SyncAccount, SyncAdapter, SyncStatus } from '@/types';

export type { ProgressDoc, SyncAccount, SyncAdapter, SyncStatus, Unsubscribe, Mutation } from '@/types';

export const SYNC_STATUSES: readonly SyncStatus[] = [
  'signed-out',
  'syncing',
  'synced',
  'offline',
  'error',
];

export function isSyncStatus(value: unknown): value is SyncStatus {
  return typeof value === 'string' && (SYNC_STATUSES as readonly string[]).includes(value);
}

/**
 * Thrown by adapters that refuse to operate because they were never configured.
 *
 * The bundled no-op adapter does *not* throw this (see `./noop.ts`), but the
 * type is exported here so any adapter and the UI agree on one error shape.
 */
export class SyncNotConfiguredError extends Error {
  constructor(adapterName: string) {
    super(`sync adapter "${adapterName}" is not configured`);
    this.name = 'SyncNotConfiguredError';
  }
}

/* ───────────────────────────── view model ───────────────────────────── */

/**
 * Everything the Settings screen and the header badge need to render sync,
 * flattened so React components never call adapter methods during render.
 */
export interface SyncState {
  readonly adapter: string;
  readonly configured: boolean;
  readonly status: SyncStatus;
  readonly account: SyncAccount | null;
  readonly signedIn: boolean;
  /** Pending mutations in the local outbox. */
  readonly pending: number;
  /** Epoch ms of the last successful sync, or `null`. */
  readonly lastSyncAt: number | null;
  /** Human-readable error from the last failed attempt, or `null`. */
  readonly error: string | null;
}

export interface SyncStateInput {
  readonly pending?: number;
  readonly lastSyncAt?: number | null;
  readonly error?: string | null;
}

/** Build a {@link SyncState} by sampling an adapter once. Never throws. */
export function readSyncState(adapter: SyncAdapter, extra: SyncStateInput = {}): SyncState {
  let status: SyncStatus = 'error';
  let account: SyncAccount | null = null;
  let error: string | null = extra.error ?? null;
  try {
    status = adapter.status();
    account = adapter.account();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'sync adapter failed';
  }
  return {
    adapter: adapter.name,
    configured: adapter.configured,
    status,
    account,
    signedIn: account !== null,
    pending: extra.pending ?? 0,
    lastSyncAt: extra.lastSyncAt ?? null,
    error,
  };
}

/* ───────────────────────────── descriptions ─────────────────────────── */

export interface StatusDescription {
  /** i18n key under `sync.*`. */
  readonly i18nKey: string;
  /** Whether a spinner belongs next to the label. */
  readonly busy: boolean;
  /** Severity, for choosing a colour without hard-coding one here. */
  readonly tone: 'neutral' | 'positive' | 'warning' | 'danger';
}

const DESCRIPTIONS: Readonly<Record<SyncStatus, StatusDescription>> = {
  'signed-out': { i18nKey: 'sync.status.signedOut', busy: false, tone: 'neutral' },
  syncing: { i18nKey: 'sync.status.syncing', busy: true, tone: 'neutral' },
  synced: { i18nKey: 'sync.status.synced', busy: false, tone: 'positive' },
  offline: { i18nKey: 'sync.status.offline', busy: false, tone: 'warning' },
  error: { i18nKey: 'sync.status.error', busy: false, tone: 'danger' },
};

/** Pure status → presentation mapping. Total over `SyncStatus`. */
export function describeStatus(status: SyncStatus): StatusDescription {
  return DESCRIPTIONS[status];
}

/**
 * Structural check that an object really implements the contract.
 *
 * Useful at the boundary where an adapter is chosen at runtime (configured vs.
 * not) and for asserting in tests that an adapter is complete.
 */
export function isSyncAdapter(value: unknown): value is SyncAdapter {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<keyof SyncAdapter, unknown>>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.configured === 'boolean' &&
    typeof candidate.status === 'function' &&
    typeof candidate.account === 'function' &&
    typeof candidate.signIn === 'function' &&
    typeof candidate.signOut === 'function' &&
    typeof candidate.pull === 'function' &&
    typeof candidate.push === 'function' &&
    typeof candidate.subscribe === 'function'
  );
}

/** Every method name the contract requires — handy for exhaustive tests. */
export const SYNC_ADAPTER_METHODS = [
  'status',
  'account',
  'signIn',
  'signOut',
  'pull',
  'push',
  'subscribe',
] as const satisfies readonly (keyof SyncAdapter)[];
