// Account deletion, from the user's side of the confirmation.
//
// The gap this closes: a sign-in feature the user cannot undo is one they cannot
// meaningfully consent to. "Reset everything" empties the cloud document but
// leaves the Firebase auth record — which holds the email address, display name
// and sign-in timestamps — in place with no way to remove it from inside the app.
//
// The control is deliberately conditional on there being an account, so both
// halves of that condition are covered below.

import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@/i18n/useT';
import type { DeleteAccountOutcome } from '@/store';
import type { Mutation, ProgressDoc, SyncAccount, SyncAdapter, SyncStatus } from '@/types';
// Type-only, so it is erased before the hoisted `vi.mock` factory below runs.
import type { AccountObservable } from '@/lib/sync/firestore';
import { closeDb, deleteDb } from '@/lib/db';
import { DangerZone } from './DangerZone';

const ACCOUNT: SyncAccount = { uid: 'u1', email: 'me@example.com', displayName: 'Me' };

const h = vi.hoisted(() => ({
  configured: true,
  account: null as SyncAccount | null,
  /** What the store's orchestration reports back. */
  outcome: 'deleted' as DeleteAccountOutcome,
  deletions: 0,
}));

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
    signIn: (): Promise<void> => Promise.resolve(),
    signOut: (): Promise<void> => Promise.resolve(),
    pull: (): Promise<ProgressDoc | null> => Promise.resolve(null),
    push: (_mutations: readonly Mutation[]): Promise<void> => Promise.resolve(),
    subscribe: () => (): void => {},
    onAccountChanged: () => (): void => {},
  }),
  supportsAccountObservation: (adapter: SyncAdapter): boolean =>
    'onAccountChanged' in adapter && typeof adapter.onAccountChanged === 'function',
}));

const { useAppStore } = await import('@/store');
const { resetSyncDriverForTests } = await import('@/lib/sync/driver');

function renderZone() {
  return render(
    <I18nProvider initialLocale="en">
      <DangerZone />
    </I18nProvider>,
  );
}

beforeEach(async () => {
  await closeDb();
  await deleteDb();
  resetSyncDriverForTests();
  Object.assign(h, { configured: true, account: ACCOUNT, outcome: 'deleted', deletions: 0 });
  await useAppStore.getState().hydrate();
  // Stub the orchestration: what is under test here is the confirmation and the
  // four different things the UI has to say, not the delete sequence itself
  // (covered in `lib/sync/firestore.delete.test.ts`).
  useAppStore.setState({
    deleteAccount: (): Promise<DeleteAccountOutcome> => {
      h.deletions += 1;
      return Promise.resolve(h.outcome);
    },
  });
});

afterEach(async () => {
  cleanup();
  await closeDb();
});

describe('the account-deletion control', () => {
  it('is offered when there is an account', async () => {
    renderZone();

    const block = await screen.findByTestId('danger-delete-account');
    expect(block).toHaveTextContent(/delete your account/i);
    // Says what it removes that a progress reset does not.
    expect(block).toHaveTextContent(/both here and in the cloud/i);
  });

  it('is absent when nobody is signed in', async () => {
    h.account = null;
    renderZone();

    // Let the mount effect settle, so this is not just "the effect has not run".
    await screen.findAllByText(/reset everything/i);
    await waitFor(() => expect(screen.queryByTestId('danger-delete-account')).toBeNull());
  });

  it('is absent when sync was never configured', async () => {
    h.configured = false;
    renderZone();

    await screen.findAllByText(/reset everything/i);
    await waitFor(() => expect(screen.queryByTestId('danger-delete-account')).toBeNull());
  });

  it('asks first, and does nothing on the opening tap', async () => {
    const user = userEvent.setup();
    renderZone();

    await user.click(await screen.findByRole('button', { name: /delete your account/i }));

    const dialog = screen.getByRole('alertdialog', { name: /delete your account/i });
    expect(dialog).toHaveTextContent(/this cannot be undone/i);
    // Google almost always asks again, because a restored session is too old to
    // authorise a deletion. Warning first turns a surprise popup into a step.
    expect(dialog).toHaveTextContent(/confirm it is you/i);
    expect(h.deletions).toBe(0);
  });

  it('deletes on confirmation and says so', async () => {
    const user = userEvent.setup();
    renderZone();

    await user.click(await screen.findByRole('button', { name: /delete your account/i }));
    await user.click(screen.getByRole('button', { name: /confirm/i }));

    expect(h.deletions).toBe(1);
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/have been deleted/i);
    // The account is gone, so the control that deletes it goes with it.
    await waitFor(() => expect(screen.queryByTestId('danger-delete-account')).toBeNull());
  });

  it('abandons the deletion on cancel', async () => {
    const user = userEvent.setup();
    renderZone();

    await user.click(await screen.findByRole('button', { name: /delete your account/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(h.deletions).toBe(0);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByTestId('danger-delete-account')).toBeInTheDocument();
  });

  // The three non-success endings. Reporting any of them as "deleted" would tell
  // the user their data is gone when a copy of it still exists.
  it('says the account may still exist when the deletion failed', async () => {
    h.outcome = 'failed';
    const user = userEvent.setup();
    renderZone();

    await user.click(await screen.findByRole('button', { name: /delete your account/i }));
    await user.click(screen.getByRole('button', { name: /confirm/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/could not be fully deleted/i);
    expect(status).toHaveTextContent(/try again/i);
    // Red, not green: `ok: false` is what distinguishes this from success, and
    // the colour is the only difference a glancing user will notice.
    expect(status.className).toContain('text-wrong');
    // The control stays, because retrying is the way out.
    expect(screen.getByTestId('danger-delete-account')).toBeInTheDocument();
  });

  it('explains the half-finished state when re-authentication was dismissed', async () => {
    h.outcome = 'cancelled';
    const user = userEvent.setup();
    renderZone();

    await user.click(await screen.findByRole('button', { name: /delete your account/i }));
    await user.click(screen.getByRole('button', { name: /confirm/i }));

    const status = await screen.findByRole('status');
    // Both halves of the truth: the data went, the account did not. Saying only
    // the first would be alarming; saying only the second would be wrong.
    expect(status).toHaveTextContent(/progress in the cloud was deleted/i);
    expect(status).toHaveTextContent(/account itself still exists/i);
  });

  it('stays quiet when there was nothing to delete', async () => {
    h.outcome = 'skipped';
    const user = userEvent.setup();
    renderZone();

    await user.click(await screen.findByRole('button', { name: /delete your account/i }));
    await user.click(screen.getByRole('button', { name: /confirm/i }));

    // Nothing happened, so there is nothing to announce — and certainly no error
    // to alarm someone with.
    await waitFor(() => expect(screen.queryByTestId('danger-delete-account')).toBeNull());
    expect(screen.queryByRole('status')).toBeNull();
  });
});
