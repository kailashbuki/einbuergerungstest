/**
 * Account deletion, which is the one flow where the *order* of two remote calls
 * is the correctness property.
 *
 * `firestore.rules` gates every operation on `isOwner(uid)`. The moment the auth
 * record is gone, no request can satisfy that rule — so a document that outlives
 * its account is unreachable by everyone, forever, while still holding the
 * answer history and free-text notes of the person who asked us to delete it.
 * Deleting the document first can only leave the opposite residue: an empty
 * account the user can remove by pressing the button again.
 *
 * Its own file because the mocks are incompatible with the neighbours':
 * `firestore.test.ts` pins Firebase to *unconfigured*, and
 * `firestore.signout.test.ts` resolves `getFirebase()` to `null`. Both make the
 * code under test here unreachable.
 */

import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Mutation } from '@/types';

/** Every remote call, in the order it was made. This is the assertion surface. */
const calls: string[] = [];

const h = vi.hoisted(() => ({
  user: { uid: 'u1', email: 'a@example.com', displayName: 'A' } as {
    uid: string;
    email: string | null;
    displayName: string | null;
  } | null,
  /** Rejection for `deleteDoc`, or `null` to let it succeed. */
  deleteDocError: null as unknown,
  /** Rejections for successive `deleteUser` calls, consumed in order. */
  deleteUserErrors: [] as unknown[],
  reauthError: null as unknown,
}));

vi.mock('@/lib/firebase', () => ({
  isFirebaseConfigured: (): boolean => true,
  getFirebase: () =>
    Promise.resolve({
      app: {},
      auth: {
        get currentUser() {
          return h.user;
        },
        authStateReady: () => Promise.resolve(),
      },
      firestore: {},
    }),
}));

vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, collection: string, id: string) => `${collection}/${id}`,
  deleteDoc: (path: string) => {
    calls.push(`deleteDoc(${path})`);
    return h.deleteDocError === null ? Promise.resolve() : Promise.reject(h.deleteDocError);
  },
}));

vi.mock('firebase/auth', () => ({
  deleteUser: () => {
    calls.push('deleteUser');
    const error = h.deleteUserErrors.shift();
    if (error === undefined) {
      h.user = null;
      return Promise.resolve();
    }
    return Promise.reject(error);
  },
  reauthenticateWithPopup: () => {
    calls.push('reauthenticateWithPopup');
    return h.reauthError === null ? Promise.resolve({}) : Promise.reject(h.reauthError);
  },
  GoogleAuthProvider: class {},
  signOut: () => Promise.resolve(),
  onAuthStateChanged: () => (): void => {},
}));

const { createFirestoreAdapter, deleteSyncAccount, isSyncError, supportsAccountDeletion } =
  await import('./firestore');
const { closeDb, deleteDb } = await import('@/lib/db');
const outbox = await import('@/lib/db/outbox');
const { noopSyncAdapter } = await import('./noop');

/** A Firebase error, which carries its `code` as a property rather than a type. */
function authError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function mutation(id: string): Mutation {
  return { kind: 'xp', id, at: 1000, value: 5 };
}

beforeEach(async () => {
  await closeDb();
  await deleteDb();
  calls.length = 0;
  Object.assign(h, {
    user: { uid: 'u1', email: 'a@example.com', displayName: 'A' },
    deleteDocError: null,
    deleteUserErrors: [],
    reauthError: null,
  });
});

afterEach(async () => {
  await closeDb();
});

describe('deleteAccount', () => {
  it('deletes the document before the account, never the other way round', async () => {
    await createFirestoreAdapter().deleteAccount();

    // The whole point of the flow. Reversing these two lines strands a readable
    // copy of the user's data that nobody — including them — can ever delete.
    expect(calls).toEqual(['deleteDoc(users/u1)', 'deleteUser']);
  });

  it('ends the session, outbox included', async () => {
    await outbox.enqueueAll([mutation('m1'), mutation('m2')]);
    const adapter = createFirestoreAdapter();

    await adapter.deleteAccount();

    expect(adapter.account()).toBeNull();
    expect(adapter.status()).toBe('signed-out');
    // Those mutations address a document that no longer exists. Left queued, the
    // next account to sign in on this device would push them as its own.
    expect(await outbox.count()).toBe(0);
  });

  it('re-authenticates and retries when the credential is too old', async () => {
    // The common case, not an edge one: a session restored from a previous visit
    // is never recent enough for Firebase to authorise a deletion.
    h.deleteUserErrors = [authError('auth/requires-recent-login')];

    await createFirestoreAdapter().deleteAccount();

    expect(calls).toEqual([
      'deleteDoc(users/u1)',
      'deleteUser',
      'reauthenticateWithPopup',
      'deleteUser',
    ]);
  });

  it('reports a dismissed re-auth popup as a cancellation, not a failure', async () => {
    h.deleteUserErrors = [authError('auth/requires-recent-login')];
    h.reauthError = authError('auth/popup-closed-by-user');

    const error = await createFirestoreAdapter()
      .deleteAccount()
      .catch((e: unknown) => e);

    expect(isSyncError(error) && error.code).toBe('reauth-cancelled');
    // Closing a popup is a decision, so the UI must not shout. But the document
    // really is gone by now, so the message must not imply nothing happened
    // either — this is the sentence the user gets told.
    expect(error).toHaveProperty('message', expect.stringMatching(/your data was deleted/i));
    // One popup, then stop. Retrying re-auth in a loop would be a popup the user
    // just closed reappearing, and the second `deleteUser` would fail anyway.
    expect(calls).toEqual(['deleteDoc(users/u1)', 'deleteUser', 'reauthenticateWithPopup']);
  });

  it('never deletes the account when the document could not be deleted', async () => {
    h.deleteDocError = new Error('backend unavailable');

    const error = await createFirestoreAdapter()
      .deleteAccount()
      .catch((e: unknown) => e);

    expect(isSyncError(error) && error.code).toBe('delete-failed');
    // The failure mode we are protecting against: an account deleted while its
    // document survives is unrecoverable, so a failure here must stop the flow.
    expect(calls).toEqual(['deleteDoc(users/u1)']);
  });

  it('says the data is gone but the account is not, when only the account fails', async () => {
    h.deleteUserErrors = [new Error('internal')];

    const error = await createFirestoreAdapter()
      .deleteAccount()
      .catch((e: unknown) => e);

    expect(isSyncError(error) && error.code).toBe('delete-failed');
    // Half-done is a real state and the message must describe it, so the user
    // knows retrying is worth it rather than assuming nothing happened.
    expect(error).toHaveProperty(
      'message',
      expect.stringMatching(/data was deleted but the account itself/i),
    );
  });

  it('refuses when nobody is signed in, without touching anything', async () => {
    h.user = null;

    const error = await createFirestoreAdapter()
      .deleteAccount()
      .catch((e: unknown) => e);

    expect(isSyncError(error) && error.code).toBe('signed-out');
    expect(calls).toEqual([]);
  });
});

describe('deleteSyncAccount', () => {
  it('resolves silently for an adapter that cannot delete accounts', async () => {
    expect(supportsAccountDeletion(noopSyncAdapter)).toBe(false);
    // Callers must not have to branch on the capability; the free function is
    // what lets the store call this unconditionally.
    await expect(deleteSyncAccount(noopSyncAdapter)).resolves.toBeUndefined();
  });

  it('passes a SyncError through unchanged so the caller can branch on the code', async () => {
    h.deleteUserErrors = [authError('auth/requires-recent-login')];
    h.reauthError = authError('auth/popup-closed-by-user');

    const error = await deleteSyncAccount(createFirestoreAdapter()).catch((e: unknown) => e);

    // Flattening this to a generic 'delete-failed' would make the store show an
    // error for a popup the user chose to close.
    expect(isSyncError(error) && error.code).toBe('reauth-cancelled');
  });
});
