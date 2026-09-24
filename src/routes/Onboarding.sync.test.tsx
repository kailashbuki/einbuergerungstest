// The four-step wizard, i.e. what a user of the deployed app actually sees.
//
// Separate file rather than more cases in `Onboarding.test.tsx` because
// `vi.mock` is per-module-graph: that file pins Firebase to *unconfigured* to
// keep testing the three-step fork, and the two configurations cannot coexist in
// one graph. The Firestore adapter is faked — the wizard is written against the
// `SyncAdapter` contract and must not care what is behind it.
//
// The property that matters most here: the sync step asks for nothing. Skipping
// it, ignoring it, or failing to sign in must all still reach the first level
// with `onboarded: true` on disk. Sign-in is never a gate.

import 'fake-indexeddb/auto';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Onboarding from './Onboarding';
import { I18nProvider } from '@/i18n/useT';
import { closeDb, deleteDb } from '@/lib/db';
import { useAppStore } from '@/store';
import type { Mutation, ProgressDoc, SyncAccount, SyncAdapter, SyncStatus } from '@/types';

const ACCOUNT: SyncAccount = { uid: 'u1', email: 'me@example.com', displayName: 'Me' };

/** `vi.hoisted`: the mock factories below run before this module's body. */
const h = vi.hoisted(() => ({
  signIns: 0,
  pushes: 0,
  account: null as SyncAccount | null,
  signInError: null as Error | null,
}));

vi.mock('@/lib/firebase', () => ({
  isFirebaseConfigured: (): boolean => true,
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
      if (h.signInError !== null) return Promise.reject(h.signInError);
      h.account = ACCOUNT;
      return Promise.resolve();
    },
    signOut(): Promise<void> {
      h.account = null;
      return Promise.resolve();
    },
    pull: (): Promise<ProgressDoc | null> => Promise.resolve(null),
    push(_mutations: readonly Mutation[]): Promise<void> {
      h.pushes += 1;
      return Promise.resolve();
    },
    subscribe: () => (): void => {},
  }),
}));

const { resetSyncDriverForTests } = await import('@/lib/sync/driver');

async function freshStore(): Promise<void> {
  await closeDb();
  await deleteDb();
  resetSyncDriverForTests();
  Object.assign(h, { signIns: 0, pushes: 0, account: null, signInError: null });
  useAppStore.setState({
    hydrated: false,
    settings: {
      state: null,
      uiLocale: 'en',
      translation: 'off',
      alwaysShowTranslation: false,
      mockTranslations: false,
      recallFirst: true,
      tts: true,
      ttsAutoplay: false,
      theme: 'system',
      onboarded: false,
      updatedAt: 0,
    },
    progress: {},
    sessions: [],
    mocks: [],
    practiceDays: {},
    badges: {},
    xp: 0,
  });
}

beforeEach(async () => {
  await freshStore();
});

afterEach(async () => {
  await closeDb();
});

type MemoryRouter = ReturnType<typeof createMemoryRouter>;

function renderWizard(): MemoryRouter {
  const router = createMemoryRouter(
    [
      { path: '/onboarding', element: <Onboarding /> },
      { path: '/level/:levelId', element: <div>level</div> },
      { path: '/', element: <div>dashboard</div> },
    ],
    { initialEntries: ['/onboarding'] },
  );

  render(
    <I18nProvider initialLocale="en">
      <RouterProvider router={router} />
    </I18nProvider>,
  );

  return router;
}

const user = userEvent.setup();

function primary(): HTMLElement {
  return screen.getByTestId('onb-primary');
}

async function tapPrimary(): Promise<void> {
  await waitFor(() => expect(primary()).toBeEnabled());
  await user.click(primary());
}

/** Picks a Bundesland and walks to the sync step. */
async function reachSyncStep(): Promise<MemoryRouter> {
  const router = renderWizard();
  await user.click(await screen.findByRole('radio', { name: 'Bayern' }));
  await tapPrimary(); // → 2, interface language
  await tapPrimary(); // → 3, translations
  await tapPrimary(); // → 4, sync
  expect(await screen.findByTestId('onb-signin')).toBeInTheDocument();
  return router;
}

describe('Onboarding — the sync step, when Firebase is configured', () => {
  it('adds a fourth and final step', async () => {
    renderWizard();
    await screen.findByRole('radio', { name: 'Bayern' });

    expect(screen.getByTestId('onb-step')).toHaveTextContent('Step 1 of 4');
    await user.click(await screen.findByRole('radio', { name: 'Bayern' }));
    await tapPrimary();
    await tapPrimary();
    // Step 3 is no longer the end, so its forward action is "Next", not the CTA.
    expect(screen.getByTestId('onb-step')).toHaveTextContent('Step 3 of 4');
    expect(primary()).toHaveTextContent('Next');

    await tapPrimary();
    expect(screen.getByTestId('onb-step')).toHaveTextContent('Step 4 of 4');
    expect(primary()).toHaveTextContent('Start my first level');
  });

  it('is skippable: skipping it finishes the wizard without signing in', async () => {
    const router = await reachSyncStep();

    await user.click(screen.getByTestId('onb-skip'));

    await waitFor(() => expect(useAppStore.getState().settings.onboarded).toBe(true));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/level\/.+/));
    expect(h.signIns).toBe(0);
  });

  it('signs in without advancing, then still finishes on the CTA', async () => {
    const router = await reachSyncStep();

    await user.click(screen.getByTestId('onb-signin'));

    // The click reached a real adapter, not a silent no-op fallback...
    expect(h.signIns).toBe(1);
    expect(await screen.findByText(/me@example\.com/)).toBeInTheDocument();
    // ...and sync ran, so a returning user's cloud progress is already down.
    await waitFor(() => expect(h.pushes).toBe(1));
    // Signing in is NOT the way forward: we are still on the last step.
    expect(screen.getByTestId('onb-step')).toHaveTextContent('Step 4 of 4');

    await tapPrimary();
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/level\/.+/));
    expect(useAppStore.getState().settings).toMatchObject({ state: 'BY', onboarded: true });
  });

  it('is not a gate when sign-in fails: the CTA still works', async () => {
    h.signInError = new Error('popup blocked');
    const router = await reachSyncStep();

    await user.click(screen.getByTestId('onb-signin'));

    expect(await screen.findByText(/Sign-in did not work/)).toBeInTheDocument();
    expect(screen.getByTestId('onb-signin')).toBeEnabled();

    await tapPrimary();
    await waitFor(() => expect(useAppStore.getState().settings.onboarded).toBe(true));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/level\/.+/));
  });

  it('shows a session Firebase restored from an earlier visit instead of a sign-in button', async () => {
    h.account = ACCOUNT;
    const router = renderWizard();
    await user.click(await screen.findByRole('radio', { name: 'Bayern' }));
    await tapPrimary();
    await tapPrimary();
    await tapPrimary();

    expect(await screen.findByTestId('onb-signedin')).toHaveTextContent('me@example.com');
    expect(screen.queryByTestId('onb-signin')).toBeNull();
    // The disclosure belongs next to the pending decision, so once there is no
    // decision left to make it should be gone too.
    expect(screen.queryByTestId('onb-upload-notice')).toBeNull();
    // No second sign-in was needed to get there.
    expect(h.signIns).toBe(0);

    await tapPrimary();
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/level\/.+/));
  });

  // `onb.sync.desc` is forward-looking ("your progress follows you"). This
  // wizard is also reachable by someone who studied for weeks before a Firebase
  // project existed, and their first sync uploads the whole local document — so
  // the upload has to be disclosed where the button is, not afterwards.
  it('says what will be uploaded, next to the sign-in button', async () => {
    await reachSyncStep();

    const notice = screen.getByTestId('onb-upload-notice');
    expect(notice).toHaveTextContent(/uploads the progress already on this device/i);
    expect(notice).toHaveTextContent(/notes/i);
  });

  it('stops disclosing once the user has signed in', async () => {
    await reachSyncStep();

    await user.click(screen.getByTestId('onb-signin'));

    await waitFor(() => expect(screen.queryByTestId('onb-upload-notice')).toBeNull());
    expect(await screen.findByTestId('onb-signedin')).toBeInTheDocument();
  });
});
