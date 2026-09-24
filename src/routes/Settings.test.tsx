// jsdom has no IndexedDB; this installs an in-memory implementation on
// globalThis and must come before anything that opens the database.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/i18n/useT';
import { useAppStore } from '@/store';
import { closeDb, deleteDb } from '@/lib/db';
import Settings from './Settings';

/**
 * Pin the sync panel to its unconfigured state. Settings is rendered here to
 * test the *settings* behaviour, and a configured Firebase config would
 * otherwise have `SyncStatusCard` try to sign in and talk to the network on
 * mount. The configured branch is covered in `src/lib/sync/*.test.ts`.
 */
vi.mock('@/lib/firebase', () => ({
  isFirebaseConfigured: (): boolean => false,
  getFirebase: (): Promise<null> => Promise.resolve(null),
}));

/**
 * Same reset pattern as `src/store/index.test.ts`: the Zustand singleton is
 * reset AND IndexedDB is deleted before every test, so nothing leaks between
 * cases.
 */
async function freshStore(): Promise<void> {
  await closeDb();
  await deleteDb();
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
  await useAppStore.getState().hydrate();
}

function renderSettings() {
  return render(
    <I18nProvider initialLocale="en">
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(async () => {
  await freshStore();
  // `saveSettings` defaults (schema.ts) leave `uiLocale: 'de'` and
  // `recallFirst: false` — pin the fields under test explicitly so each case
  // starts from a known baseline rather than the raw on-disk defaults.
  await useAppStore.getState().patchSettings({
    state: 'BW',
    onboarded: true,
    uiLocale: 'en',
    recallFirst: true,
    tts: true,
  });
});

afterEach(() => {
  cleanup();
});

describe('Settings', () => {
  it('toggles recallFirst immediately and never renders a save button', async () => {
    const user = userEvent.setup();
    renderSettings();

    const toggle = await screen.findByRole('switch', { name: 'Recall first' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(useAppStore.getState().settings.recallFirst).toBe(true);

    await user.click(toggle);

    await waitFor(() => expect(useAppStore.getState().settings.recallFirst).toBe(false));
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
  });

  it('changes the interface language and writes settings.uiLocale immediately, with no reload', async () => {
    const user = userEvent.setup();
    renderSettings();

    expect(useAppStore.getState().settings.uiLocale).toBe('en');

    const deutschOption = await screen.findByRole('radio', { name: 'Deutsch' });
    await user.click(deutschOption);

    await waitFor(() => expect(useAppStore.getState().settings.uiLocale).toBe('de'));
  });

  it('switching Bundesland is lossless and shows the carry-over note', async () => {
    const t0 = Date.UTC(2026, 0, 10, 9, 0, 0);
    await useAppStore.getState().answer('F001', { correct: true, hintsUsed: 0 }, t0);
    await useAppStore.getState().answer('BW01', { correct: true, hintsUsed: 0 }, t0 + 1_000);
    const bwBefore = useAppStore.getState().progress['BW01'];
    const fedBefore = useAppStore.getState().progress['F001'];

    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: 'Change Bundesland' }));
    const bayern = await screen.findByRole('radio', { name: 'Bayern' });
    await user.click(bayern);

    await waitFor(() => expect(useAppStore.getState().settings.state).toBe('BY'));

    // Federal and the previous state's progress are untouched by the switch.
    expect(useAppStore.getState().progress['BW01']).toEqual(bwBefore);
    expect(useAppStore.getState().progress['F001']).toEqual(fedBefore);

    // The carry-over note names the previous state, so users are not afraid to switch.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Baden-Württemberg'),
    );
  });

  it('resetCurrentState requires confirmation and only clears the active state', async () => {
    const t0 = Date.UTC(2026, 0, 12, 9, 0, 0);
    await useAppStore.getState().answer('F001', { correct: true, hintsUsed: 0 }, t0);
    await useAppStore.getState().answer('BW01', { correct: true, hintsUsed: 0 }, t0 + 1_000);

    const user = userEvent.setup();
    renderSettings();

    const resetButton = await screen.findByRole('button', { name: 'Reset Baden-Württemberg only' });
    await user.click(resetButton);

    // Nothing destructive has happened yet — a dialog is required first.
    expect(useAppStore.getState().progress['BW01']).toBeDefined();
    const dialog = await screen.findByRole('alertdialog');

    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(useAppStore.getState().progress['BW01']).toBeUndefined());
    expect(useAppStore.getState().progress['F001']).toBeDefined();
  });

  it('shows sync.notConfigured with no sign-in control, and nothing throws', async () => {
    renderSettings();

    expect(
      await screen.findByText(
        'Sync is not set up for this copy of the app. Everything else works normally, and your progress is saved on this device.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
  });

  it('rejects malformed import JSON and leaves existing progress untouched', async () => {
    await useAppStore.getState().answer('F001', { correct: true, hintsUsed: 0 });

    const user = userEvent.setup();
    renderSettings();

    const input = await screen.findByLabelText('Import progress');
    const file = new File(['{ not valid json'], 'backup.json', { type: 'application/json' });
    await user.upload(input, file);

    expect(await screen.findByText('That file is not a valid backup.')).toBeInTheDocument();
    expect(useAppStore.getState().progress['F001']).toBeDefined();
  });
});
