// jsdom has no IndexedDB and the store reads from it; this must be the first import.
import 'fake-indexeddb/auto';

import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import Drill from './Drill';
import { I18nProvider } from '@/i18n/useT';
import { closeDb, deleteDb } from '@/lib/db';
import { useAppStore } from '@/store';

/**
 * A genuinely empty browser for every test: the Zustand singleton is reset AND
 * the IndexedDB database is deleted, then hydrated fresh.
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
  await useAppStore.getState().hydrate();
}

beforeEach(async () => {
  await freshStore();
});

type MemoryRouter = ReturnType<typeof createMemoryRouter>;

/** Renders `Drill` at `initialPath`, plus stub destinations so a real navigation is observable. */
function renderDrill(initialPath = '/drill'): MemoryRouter {
  const router = createMemoryRouter(
    [
      { path: '/drill', element: <Drill /> },
      { path: '/drill/run', element: <div>runner</div> },
      { path: '/worlds', element: <div>worlds</div> },
    ],
    { initialEntries: [initialPath] },
  );

  render(
    <I18nProvider initialLocale="en">
      <RouterProvider router={router} />
    </I18nProvider>,
  );

  return router;
}

describe('Drill launcher — due scope', () => {
  it('shows an empty state for a brand-new user and renders no launch link for it', async () => {
    await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true });
    renderDrill();

    const dueCard = screen.getByTestId('scope-card-due');
    // No never-answered question counts as "due for review" on this screen —
    // a fresh account has nothing to review yet, only things to learn.
    expect(within(dueCard).queryByRole('link', { name: /start drill/i })).toBeNull();
    expect(within(dueCard).getByText('Nothing due for review. Play a level first.')).toBeInTheDocument();
    // The empty state still points somewhere useful instead of a dead end.
    expect(within(dueCard).getByRole('link', { name: /worlds/i })).toHaveAttribute('href', '/worlds');
  });
});

describe('Drill launcher — flagged scope', () => {
  it('counts flagged questions from the store and links straight to the flagged runner', async () => {
    await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true });
    await useAppStore.getState().toggleFlag('F001');
    await useAppStore.getState().toggleFlag('F002');

    const flaggedInStore = Object.values(useAppStore.getState().progress).filter((p) => p.flagged).length;
    expect(flaggedInStore).toBe(2);

    renderDrill();

    const flaggedCard = screen.getByTestId('scope-card-flagged');
    expect(within(flaggedCard).getByText(/2 flagged/)).toBeInTheDocument();

    const link = within(flaggedCard).getByRole('link');
    expect(link).toHaveAttribute('href', '/drill/run?scope=flagged');
  });
});

describe('Drill launcher — by topic', () => {
  it('URL-encodes the category param on each topic CTA and round-trips cleanly', async () => {
    await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true });
    renderDrill();

    // The category value put on the URL is the stable `CategoryId` slug (see
    // the comment in Drill.tsx), so none of the real slugs contain a space or
    // an ampersand — the round-trip property is what we can assert generally.
    const row = screen.getByTestId('scope-category-history-geography');
    const link = within(row).getByRole('link');
    const href = link.getAttribute('href');

    expect(href).toBe(`/drill/run?scope=category&category=${encodeURIComponent('history-geography')}`);

    const url = new URL(href ?? '', 'https://example.test');
    expect(url.searchParams.get('scope')).toBe('category');
    expect(url.searchParams.get('category')).toBe('history-geography');
  });
});

describe('Drill launcher — inbound highlight', () => {
  it('highlights the nemesis scope from /drill?scope=nemesis without navigating away', async () => {
    await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true });
    const router = renderDrill('/drill?scope=nemesis');

    expect(screen.getByTestId('scope-card-nemesis')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('scope-card-due')).not.toHaveAttribute('aria-current');

    // Control kept with the user: arriving highlighted must not auto-start a session.
    expect(router.state.location.pathname).toBe('/drill');
    expect(router.state.location.search).toBe('?scope=nemesis');
  });
});
