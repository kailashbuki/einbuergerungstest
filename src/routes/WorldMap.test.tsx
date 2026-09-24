// jsdom has no IndexedDB; this installs an in-memory implementation on
// globalThis and must come before anything that opens the database.
import 'fake-indexeddb/auto';

import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '@/store';
import { closeDb, deleteDb } from '@/lib/db';
import { UNLOCK_THRESHOLD_PERCENT, nextLevel, worldsOf } from '@/lib/curriculum';
import { levelStars } from '@/lib/mastery';
import { STATES_BY_CODE } from '@/data/states';
import { I18nProvider } from '@/i18n/useT';
import WorldMap from './WorldMap';

// The first two levels of the first federal world, used throughout as fixed,
// known fixtures rather than magic strings scattered per test.
const WORLD_1_LEVEL_1 = {
  id: 'history-geography-nazi-dictatorship',
  name: 'The Nazi dictatorship',
  questionIds: ['F009', 'F036', 'F015', 'F012', 'F024', 'F031', 'F018', 'F021', 'F027', 'F017', 'F029', 'F001'],
};
const WORLD_1_LEVEL_2 = {
  id: 'history-geography-occupation',
  name: 'Occupation and two German states',
  questionIds: ['F008', 'F044', 'F047', 'F056', 'F061', 'F058', 'F064', 'F049', 'F051', 'F054', 'F005', 'F066'],
};

/** Same reset pattern as `src/store/index.test.ts`: a genuinely empty browser each time. */
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

function renderWorldMap() {
  return render(
    <MemoryRouter>
      <I18nProvider initialLocale="en">
        <WorldMap />
      </I18nProvider>
    </MemoryRouter>,
  );
}

/** Answers `count` of a level's questions correctly, in order. */
async function answerCorrect(questionIds: readonly string[], count: number): Promise<void> {
  for (const id of questionIds.slice(0, count)) {
    await useAppStore.getState().answer(id, { correct: true, hintsUsed: 0 });
  }
}

beforeEach(async () => {
  await freshStore();
});

describe('WorldMap', () => {
  it('renders all 11 worlds for BW, including the Heimat world titled with the state name', async () => {
    await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true });
    renderWorldMap();

    const worlds = worldsOf('BW');
    expect(worlds).toHaveLength(11);
    for (const world of worlds) {
      // The Heimat world's single level shares its name with the world itself
      // (both are the bare state name), so there can legitimately be two
      // matches there; every other world's name is unique on the page.
      expect(screen.getAllByText(world.name).length).toBeGreaterThanOrEqual(1);
    }
    expect(screen.getAllByText(STATES_BY_CODE.BW.name).length).toBeGreaterThanOrEqual(1);
  });

  it('re-derives the Heimat world when the active state switches', async () => {
    await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true });
    renderWorldMap();
    expect(screen.getAllByText('Baden-Württemberg').length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      await useAppStore.getState().switchState('BY');
    });

    expect(screen.queryAllByText('Baden-Württemberg')).toHaveLength(0);
    expect(screen.getAllByText('Bayern').length).toBeGreaterThanOrEqual(1);
  });

  it('keeps a locked level focusable and explains why it is locked, offering a way in anyway', async () => {
    await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true });
    renderWorldMap();

    // With no progress at all, the second level of a world is soft-locked
    // (reason: 'needs-previous') while the first level of every world stays open.
    const nameNode = screen.getByText(WORLD_1_LEVEL_2.name);
    const link = nameNode.closest('a');
    expect(link).not.toBeNull();
    if (link === null) throw new Error('unreachable');

    expect(link).toHaveAttribute('href', expect.stringContaining(`/level/${WORLD_1_LEVEL_2.id}`));

    link.focus();
    expect(document.activeElement).toBe(link);

    expect(
      within(link).getByText(new RegExp(`Clear ${UNLOCK_THRESHOLD_PERCENT}% of the previous level`)),
    ).toBeInTheDocument();
    expect(within(link).getByText('Enter anyway')).toBeInTheDocument();
  });

  it('shows stars consistent with levelStars for a level cleared above the threshold', async () => {
    await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true });
    // 9 of 12 correct = 75%, above the 70% clear threshold.
    await answerCorrect(WORLD_1_LEVEL_2.questionIds, 9);
    renderWorldMap();

    const expectedStars = levelStars(WORLD_1_LEVEL_2.questionIds, useAppStore.getState().progress);
    expect(expectedStars).toBeGreaterThan(0);

    const nameNode = screen.getByText(WORLD_1_LEVEL_2.name);
    const tile = nameNode.closest('li');
    expect(tile).not.toBeNull();
    if (tile === null) throw new Error('unreachable');

    const starImg = within(tile).getByRole('img');
    expect(starImg).toHaveAttribute('aria-label', `${expectedStars} of 3 stars`);
  });

  it('marks the level that nextLevel returns as recommended', async () => {
    await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true });
    // Fully clear the very first level so there is an unambiguous "next" level.
    await answerCorrect(WORLD_1_LEVEL_1.questionIds, WORLD_1_LEVEL_1.questionIds.length);
    renderWorldMap();

    const expected = nextLevel('BW', WORLD_1_LEVEL_1.id);
    expect(expected).toBeDefined();
    expect(expected?.id).toBe(WORLD_1_LEVEL_2.id);

    const recommendedTile = screen.getByText(WORLD_1_LEVEL_2.name).closest('li');
    expect(recommendedTile).not.toBeNull();
    if (recommendedTile === null) throw new Error('unreachable');
    expect(within(recommendedTile).getByText('Recommended next')).toBeInTheDocument();

    const clearedTile = screen.getByText(WORLD_1_LEVEL_1.name).closest('li');
    expect(clearedTile).not.toBeNull();
    if (clearedTile === null) throw new Error('unreachable');
    expect(within(clearedTile).queryByText('Recommended next')).not.toBeInTheDocument();
  });
});
