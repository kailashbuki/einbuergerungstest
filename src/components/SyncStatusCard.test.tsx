// The sign-in button is the one control that only appears when Firebase is
// configured, which means no test that runs against the unconfigured default
// ever sees it — that is how a dead adapter factory
// (`createFirestoreSyncAdapter`, which never existed) shipped unnoticed. These
// cases render the configured branch with a fake adapter, so both halves of the
// panel are covered.

import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@/i18n/useT';
import type { Mutation, ProgressDoc, SyncAccount, SyncAdapter, SyncStatus } from '@/types';
// Type-only, so it is erased before the hoisted `vi.mock` factory below runs and
// cannot re-enter the module being mocked.
import type { AccountObservable } from '@/lib/sync/firestore';
import { closeDb, deleteDb } from '@/lib/db';
import { SyncStatusCard } from './SyncStatusCard';

const ACCOUNT: SyncAccount = { uid: 'u1', email: 'me@example.com', displayName: 'Me' };

const h = vi.hoisted(() => ({
  configured: true,
  signIns: 0,
  signOuts: 0,
  account: null as SyncAccount | null,
  /** Account-change subscribers, so a test can end the session from outside. */
  watchers: new Set<(account: SyncAccount | null) => void>(),
}));

/** Simulate a session ending somewhere other than this tab. */
function endSessionExternally(): void {
  h.account = null;
  for (const watcher of h.watchers) watcher(null);
}

vi.mock('@/lib/firebase', () => ({
  isFirebaseConfigured: (): boolean => h.configured,
  getFirebase: (): Promise<null> => Promise.resolve(null),
}));

vi.mock('@/lib/sync/firestore', () => ({
  createFirestoreAdapter: (): SyncAdapter & AccountObservable => ({
    name: 'fake-firestore',
    configured: true,
    status: (): SyncStatus => (h.account === null ? 'signed-out' : 'synced'),
    account: (): SyncAccount | null => h.account,
    signIn(): Promise<void> {
      h.signIns += 1;
      h.account = ACCOUNT;
      return Promise.resolve();
    },
    signOut(): Promise<void> {
      h.signOuts += 1;
      h.account = null;
      return Promise.resolve();
    },
    pull: (): Promise<ProgressDoc | null> => Promise.resolve(null),
    push: (_mutations: readonly Mutation[]): Promise<void> => Promise.resolve(),
    subscribe: () => (): void => {},
    onAccountChanged(callback: (account: SyncAccount | null) => void) {
      h.watchers.add(callback);
      return (): void => {
        h.watchers.delete(callback);
      };
    },
  }),
  // The component resolves this predicate through a dynamic import so the one
  // definition stays next to the capability. Mocking the module means mocking
  // it too — leaving it out would silently disable the observation path here
  // while production kept it, which is the drift the shared predicate prevents.
  supportsAccountObservation: (adapter: SyncAdapter): boolean =>
    'onAccountChanged' in adapter && typeof adapter.onAccountChanged === 'function',
}));

const { resetSyncDriverForTests } = await import('@/lib/sync/driver');

function renderCard() {
  return render(
    <I18nProvider initialLocale="en">
      <SyncStatusCard />
    </I18nProvider>,
  );
}

beforeEach(async () => {
  await closeDb();
  await deleteDb();
  resetSyncDriverForTests();
  Object.assign(h, { configured: true, signIns: 0, signOuts: 0, account: null });
  h.watchers.clear();
});

afterEach(async () => {
  cleanup();
  await closeDb();
});

describe('the sync panel when Firebase is configured', () => {
  it('offers a sign-in button', async () => {
    renderCard();

    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    // And not the "nothing to see here" panel.
    expect(screen.queryByText(/Sync is not set up for this copy of the app/)).not.toBeInTheDocument();
  });

  it('reaches a real adapter: signing in shows the account and a sync control', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('button', { name: /sign in/i }));

    // The click must reach the adapter — not a silent no-op fallback.
    expect(h.signIns).toBe(1);
    expect(await screen.findByText(/me@example\.com/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /sync now/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^sign in$/i })).not.toBeInTheDocument();
  });

  it('signs out again', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('button', { name: /sign in/i }));
    await user.click(await screen.findByRole('button', { name: /sign out/i }));
    await user.click(await screen.findByRole('button', { name: /^sign out$/i }));

    expect(h.signOuts).toBe(1);
    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument());
  });
});

// Signing out on your own phone and signing out on a library computer want
// opposite things done with the local copy, and one button cannot tell them
// apart. Before this the app always kept the data, which is the wrong default
// for exactly the case where it matters.
describe('the sign-out data choice', () => {
  async function signInThenAskToSignOut(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: /sign in/i }));
    await user.click(await screen.findByRole('button', { name: /sign out/i }));
    return screen.findByTestId('sync-signout-choice');
  }

  it('does not sign out on the first tap — it asks what to do with the data', async () => {
    const user = userEvent.setup();
    renderCard();

    const choice = await signInThenAskToSignOut(user);

    // The tap that opens the choice must not itself end the session, or the
    // "cancel" branch would be a lie.
    expect(h.signOuts).toBe(0);
    expect(choice).toHaveAttribute('role', 'alertdialog');
    // Both outcomes named, and each says what happens to the data rather than
    // leaving the user to guess which one is safe.
    expect(choice).toHaveTextContent(/stays on this device and in your account/i);
    expect(choice).toHaveTextContent(/stays safely in your account and is deleted from this device/i);
  });

  it('keeps the local progress when that is what the user chose', async () => {
    const user = userEvent.setup();
    renderCard();
    await signInThenAskToSignOut(user);

    await user.click(screen.getByRole('button', { name: /^sign out$/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument());
    expect(h.signOuts).toBe(1);
    // No wipe happened, so nothing claims one did.
    expect(screen.queryByTestId('sync-wiped')).toBeNull();
  });

  it('wipes this device, and only this device, when asked to', async () => {
    const user = userEvent.setup();
    renderCard();
    // Something to lose: without a prior write the wipe is unobservable and the
    // test would pass against a `wipeLocalData` that did nothing at all.
    const { useAppStore } = await import('@/store');
    await useAppStore.getState().hydrate();
    await useAppStore.getState().answer('F001', { correct: true, hintsUsed: 0 });
    expect(useAppStore.getState().progress['F001']).toBeDefined();

    await signInThenAskToSignOut(user);
    await user.click(screen.getByRole('button', { name: /remove from this device/i }));

    expect(await screen.findByTestId('sync-wiped')).toHaveTextContent(/safe in your account/i);
    expect(h.signOuts).toBe(1);
    await waitFor(() => expect(useAppStore.getState().progress['F001']).toBeUndefined());
  });

  it('leaves everything alone when the choice is cancelled', async () => {
    const user = userEvent.setup();
    renderCard();
    await signInThenAskToSignOut(user);

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByTestId('sync-signout-choice')).toBeNull());
    expect(h.signOuts).toBe(0);
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });
});

// A session can end without anyone touching this tab: access revoked from the
// Google account, the account deleted on another device, a sign-out elsewhere.
// Until the adapter reported those, the panel went on saying "Signed in as …"
// while every write failed with a generic error.
describe('a session that ends elsewhere', () => {
  it('stops claiming to be signed in, and says why', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('button', { name: /sign in/i }));
    await screen.findByText(/me@example\.com/);
    // The observer must actually be attached — not merely offered by the adapter.
    await waitFor(() => expect(h.watchers.size).toBe(1));

    endSessionExternally();

    expect(await screen.findByTestId('sync-session-ended')).toHaveTextContent(
      /removed this app's access to your Google account/i,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument());
    expect(screen.queryByText(/me@example\.com/)).toBeNull();
    // And it must not go on confirming a merge into an account that is gone.
    expect(screen.queryByTestId('sync-merged')).toBeNull();
  });

  it('detaches the observer when the panel unmounts', async () => {
    renderCard();
    await waitFor(() => expect(h.watchers.size).toBe(1));

    cleanup();

    // A leaked subscription would fire into an unmounted tree on the next
    // transition — a React warning at best, a stale panel at worst.
    expect(h.watchers.size).toBe(0);
  });
});

// What leaves the device, said before the tap rather than after it. The first
// cycle after sign-in uploads the *whole* local document — answers, flagged
// questions, free-text notes — and until these strings were rendered the UI
// never said so: `sync.merged` was defined in all 8 locales and used nowhere.
describe('the sync panel disclosure', () => {
  it('says what will be uploaded while the sign-in button is still the pending action', async () => {
    renderCard();

    const notice = await screen.findByTestId('sync-upload-notice');
    expect(notice).toHaveTextContent(/uploads the progress already on this device/i);
    // Naming the specific categories is the point; a vague "syncs your data"
    // would pass a looser assertion.
    expect(notice).toHaveTextContent(/answers/i);
    expect(notice).toHaveTextContent(/notes/i);
  });

  it('drops the notice once there is nothing left to disclose', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.queryByTestId('sync-upload-notice')).not.toBeInTheDocument());
  });

  it('confirms the merge afterwards, announced', async () => {
    const user = userEvent.setup();
    renderCard();

    // Not before: the panel runs a background sync on mount, and that must not
    // produce a confirmation for something the user did not just do.
    await screen.findByRole('button', { name: /sign in/i });
    expect(screen.queryByTestId('sync-merged')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const merged = await screen.findByTestId('sync-merged');
    expect(merged).toHaveAttribute('role', 'status');
    expect(merged).toHaveTextContent(/merged/i);
  });

  // Guards the user-visible property, not one particular line: the confirmation
  // is gated on `justMerged && signedIn`, so either the `setJustMerged(false)`
  // in `handleSignOut` or the `signedIn` half is enough to satisfy this. That
  // redundancy is deliberate — deleting either one must not regress the panel.
  it('does not keep confirming a merge after the user has signed out', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('button', { name: /sign in/i }));
    await screen.findByTestId('sync-merged');
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    await user.click(await screen.findByRole('button', { name: /^sign out$/i }));

    await waitFor(() => expect(screen.queryByTestId('sync-merged')).not.toBeInTheDocument());
    expect(screen.getByTestId('sync-upload-notice')).toBeInTheDocument();
  });
});

describe('the sync panel when Firebase is unconfigured', () => {
  it('explains itself calmly, with no sign-in button', async () => {
    h.configured = false;
    renderCard();

    expect(
      await screen.findByText(
        'Sync is not set up for this copy of the app. Everything else works normally, and your progress is saved on this device.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
  });
});
