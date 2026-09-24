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
import { closeDb, deleteDb } from '@/lib/db';
import { SyncStatusCard } from './SyncStatusCard';

const ACCOUNT: SyncAccount = { uid: 'u1', email: 'me@example.com', displayName: 'Me' };

const h = vi.hoisted(() => ({
  configured: true,
  signIns: 0,
  signOuts: 0,
  account: null as SyncAccount | null,
}));

vi.mock('@/lib/firebase', () => ({
  isFirebaseConfigured: (): boolean => h.configured,
  getFirebase: (): Promise<null> => Promise.resolve(null),
}));

vi.mock('@/lib/sync/firestore', () => ({
  createFirestoreAdapter: (): SyncAdapter => ({
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
  }),
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

    expect(h.signOuts).toBe(1);
    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument());
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
