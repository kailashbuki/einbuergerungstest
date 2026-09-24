// jsdom has no IndexedDB and the wizard's every choice goes through the store,
// which writes to it. This must be the first import in the file.
import 'fake-indexeddb/auto';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import Onboarding from './Onboarding';
import { detectTranslationLocale, detectUiLocale } from '@/i18n/index';
import { I18nProvider } from '@/i18n/useT';
import { closeDb, deleteDb } from '@/lib/db';
import { useAppStore } from '@/store';

/**
 * A genuinely empty browser for every test: the Zustand singleton is reset AND
 * the database is deleted. Deliberately does NOT hydrate — the component does
 * that itself, which is what exercises the first-run seeding path.
 * (Pattern copied from `src/store/index.test.ts`.)
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
}

beforeEach(async () => {
  await freshStore();
});

/**
 * Renders the wizard at `/onboarding` with stand-ins for the two destinations it
 * can navigate to, so the router's location is an assertable outcome.
 */
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

/**
 * The footer buttons are addressed by test id rather than by label: their labels
 * come from `onb.*` keys, and `useT` humanises a key that is still missing from
 * the locale tables, so the visible text is not a stable handle. Everything
 * else is queried by role/accessible name — German state names and language
 * endonyms are never translated, so those are stable by design.
 */
function primary(): HTMLElement {
  return screen.getByTestId('onb-primary');
}

/** Waits for the forward action to be enabled, then taps it. */
async function tapPrimary(): Promise<void> {
  await waitFor(() => expect(primary()).toBeEnabled());
  await user.click(primary());
}

function uiLanguageGroup(): Promise<HTMLElement> {
  return screen.findByRole('radiogroup', { name: 'Interface language' });
}

function translationGroup(): Promise<HTMLElement> {
  return screen.findByRole('radiogroup', { name: 'Question translations' });
}

/** Step 1 is on screen once the 16 Bundesland radios are. */
function bavaria(): Promise<HTMLElement> {
  return screen.findByRole('radio', { name: 'Bayern' });
}

describe('Onboarding — step 1 (Bundesland, required)', () => {
  it('pre-selects nothing and blocks progress until a state is chosen', async () => {
    renderWizard();
    await bavaria();

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(16);
    for (const radio of radios) {
      expect(radio).toHaveAttribute('aria-checked', 'false');
    }

    // Blocked, and the reason is on screen and wired to the disabled control.
    expect(primary()).toBeDisabled();
    const reasonId = primary().getAttribute('aria-describedby');
    expect(reasonId).not.toBeNull();
    expect(document.getElementById(reasonId ?? '')).toBeInTheDocument();

    // Still step 1: step 2's picker has not appeared.
    expect(screen.queryByRole('radiogroup', { name: 'Interface language' })).toBeNull();
    expect(useAppStore.getState().settings.onboarded).toBe(false);

    await user.click(await bavaria());
    await waitFor(() => expect(primary()).toBeEnabled());
    expect(await bavaria()).toHaveAttribute('aria-checked', 'true');
  });

  it('sends the chosen state to the store, not just to local state', async () => {
    renderWizard();
    await user.click(await bavaria());

    await waitFor(() => expect(useAppStore.getState().settings.state).toBe('BY'));
    // ...but it must NOT let the user out of the wizard yet.
    expect(useAppStore.getState().settings.onboarded).toBe(false);
  });
});

describe('Onboarding — the whole wizard', () => {
  it('persists state, both languages and onboarded, then enters the first level', async () => {
    const router = renderWizard();

    await user.click(await bavaria());
    await tapPrimary();

    // Step 2 — interface language, applied immediately rather than on finish.
    await user.click(within(await uiLanguageGroup()).getByRole('radio', { name: 'Türkçe' }));
    await waitFor(() => expect(useAppStore.getState().settings.uiLocale).toBe('tr'));
    expect(useAppStore.getState().settings.onboarded).toBe(false);
    await tapPrimary();

    // Step 3 — question translations, likewise immediate.
    await user.click(within(await translationGroup()).getByRole('radio', { name: 'Русский' }));
    await waitFor(() => expect(useAppStore.getState().settings.translation).toBe('ru'));
    expect(useAppStore.getState().settings.onboarded).toBe(false);

    // The one final CTA.
    await tapPrimary();

    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/level\/.+/));
    expect(useAppStore.getState().settings).toMatchObject({
      state: 'BY',
      uiLocale: 'tr',
      translation: 'ru',
      onboarded: true,
    });
  });

  it('survives a reload: the finished settings are on disk, not only in memory', async () => {
    const router = renderWizard();
    await user.click(await bavaria());
    await tapPrimary();
    await user.click(within(await uiLanguageGroup()).getByRole('radio', { name: 'Français' }));
    await tapPrimary();
    await tapPrimary();
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/level\/.+/));

    // Throw the in-memory snapshot away and re-read IndexedDB.
    useAppStore.setState({ hydrated: false });
    await useAppStore.getState().reloadFromDb();
    const settings = useAppStore.getState().settings;
    expect(settings.state).toBe('BY');
    expect(settings.uiLocale).toBe('fr');
    expect(settings.onboarded).toBe(true);
  });

  it('lets the user skip steps 2 and 3 and still finishes, keeping the detected defaults', async () => {
    const router = renderWizard();

    // The browser-detected languages are seeded on first run, so "skip" has
    // something to keep.
    await waitFor(() => expect(useAppStore.getState().settings.uiLocale).toBe(detectUiLocale()));

    await user.click(await bavaria());
    await tapPrimary();

    await uiLanguageGroup();
    await user.click(screen.getByTestId('onb-skip'));

    await translationGroup();
    await user.click(screen.getByTestId('onb-skip'));

    await waitFor(() => expect(useAppStore.getState().settings.onboarded).toBe(true));
    const settings = useAppStore.getState().settings;
    expect(settings.state).toBe('BY');
    // Skipped, so the detected values must still be there — not blanked.
    expect(settings.uiLocale).toBe(detectUiLocale());
    expect(settings.translation).toBe(detectTranslationLocale());
    expect(router.state.location.pathname).toMatch(/^\/level\/.+/);
  });

  it('can go back to step 1 and change the state without losing the language choices', async () => {
    renderWizard();
    await user.click(await bavaria());
    await tapPrimary();
    await user.click(within(await uiLanguageGroup()).getByRole('radio', { name: 'Türkçe' }));
    await waitFor(() => expect(useAppStore.getState().settings.uiLocale).toBe('tr'));

    await user.click(screen.getByTestId('onb-back'));
    // A non-city-state, so the accessible name is exactly the state name.
    await user.click(await screen.findByRole('radio', { name: 'Hessen' }));
    await waitFor(() => expect(useAppStore.getState().settings.state).toBe('HE'));
    expect(useAppStore.getState().settings.uiLocale).toBe('tr');
  });

  it('offers "German only" as an explicit, selectable row on step 3', async () => {
    renderWizard();
    await user.click(await bavaria());
    await tapPrimary();
    await tapPrimary();

    const group = await translationGroup();
    const rows = within(group).getAllByRole('radio');
    // 7 translation locales + the explicit "off" row, which comes first.
    expect(rows).toHaveLength(8);
    const off = rows[0];
    expect(off).toBeDefined();
    if (off === undefined) return;
    expect(off).toHaveTextContent(/German only/i);

    await user.click(off);
    await waitFor(() => expect(useAppStore.getState().settings.translation).toBe('off'));
  });
});
