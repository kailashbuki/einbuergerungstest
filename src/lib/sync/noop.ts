/**
 * The no-op sync adapter.
 *
 * This is the adapter the app uses whenever Firebase is unconfigured — which is
 * the default, and for most users the permanent state. It is what guarantees the
 * promise that **the app is fully functional with sync never configured**: every
 * call site can treat sync as present, and nothing here can fail.
 *
 * Contract decisions, so the UI knows what to expect:
 *
 * - `configured` is `false`. That is the single flag the UI keys off to hide the
 *   sign-in affordance (or show "cloud sync unavailable in this build").
 * - `status()` is always `'signed-out'`, never `'error'`. Unconfigured is not a
 *   failure and must not surface as one.
 * - **`signIn()` / `signOut()` resolve without doing anything.** They do *not*
 *   reject with `SyncNotConfiguredError`, so a UI that optimistically calls
 *   `signIn()` needs no try/catch and no error toast. The correct UI behaviour is
 *   to check `configured` first; if it doesn't, the worst case is a click that
 *   does nothing rather than an unhandled rejection.
 * - `pull()` resolves `null` — "no remote document", indistinguishable from a
 *   fresh cloud account, which is exactly the right semantics.
 * - `push()` resolves, silently discarding the mutations. The local outbox is the
 *   caller's to manage: it should only ack after a *configured* adapter succeeds,
 *   so nothing is lost by this adapter accepting and dropping them.
 * - `subscribe()` never invokes the callback and returns a real, idempotent
 *   unsubscribe function.
 *
 * Nothing in this file throws, awaits I/O, or touches storage.
 */

import type { Mutation, ProgressDoc, SyncAccount, SyncAdapter, SyncStatus, Unsubscribe } from '@/types';

export const NOOP_ADAPTER_NAME = 'noop';

/**
 * Create a no-op adapter.
 *
 * A factory (rather than only a shared constant) so tests and future callers can
 * hold independent instances; the adapter is stateless, so they are equivalent.
 */
export function createNoopSyncAdapter(): SyncAdapter {
  return {
    name: NOOP_ADAPTER_NAME,
    configured: false,

    status(): SyncStatus {
      return 'signed-out';
    },

    account(): SyncAccount | null {
      return null;
    },

    async signIn(): Promise<void> {
      // Intentionally empty: there is nothing to sign in to.
    },

    async signOut(): Promise<void> {
      // Intentionally empty: never signed in.
    },

    async pull(): Promise<ProgressDoc | null> {
      return null;
    },

    async push(mutations: readonly Mutation[]): Promise<void> {
      // Accept and discard. Referencing `mutations` keeps the signature honest
      // and documents that nothing is inspected or retained.
      void mutations.length;
    },

    subscribe(callback: (doc: ProgressDoc) => void): Unsubscribe {
      // The callback is never invoked: there is no remote document to observe.
      void callback;
      // Idempotent by construction — calling it any number of times is safe.
      return (): void => {};
    },
  };
}

/** Shared stateless instance. Use this unless you specifically need a fresh one. */
export const noopSyncAdapter: SyncAdapter = createNoopSyncAdapter();

/** True for the bundled no-op adapter. Lets the UI explain *why* sync is off. */
export function isNoopAdapter(adapter: SyncAdapter): boolean {
  return adapter.name === NOOP_ADAPTER_NAME;
}
