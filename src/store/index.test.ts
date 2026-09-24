// jsdom has no IndexedDB; this installs an in-memory implementation on
// globalThis and must come before anything that opens the database.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from './index';
import { closeDb, deleteDb, loadProgressDoc } from '@/lib/db';
import * as outbox from '@/lib/db/outbox';
import { activeDeck } from '@/lib/deck';

/**
 * Each test starts from a genuinely empty browser: the Zustand singleton is
 * reset AND the IndexedDB database is deleted, so nothing leaks between cases.
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

describe('hydration and onboarding gate', () => {
  it('starts with no state selected so the wizard takes over', () => {
    const s = useAppStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.settings.state).toBeNull();
    expect(s.settings.onboarded).toBe(false);
  });

  it('persists settings across a reload from disk', async () => {
    await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true, uiLocale: 'tr' });
    // Drop the in-memory copy entirely and re-read IndexedDB.
    useAppStore.setState({ hydrated: false, progress: {} });
    await useAppStore.getState().reloadFromDb();
    const s = useAppStore.getState().settings;
    expect(s.state).toBe('BW');
    expect(s.onboarded).toBe(true);
    expect(s.uiLocale).toBe('tr');
  });
});

describe('answering', () => {
  it('writes progress, marks the practice day and queues a sync mutation', async () => {
    const now = Date.UTC(2026, 0, 15, 10, 0, 0);
    await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true });
    await useAppStore.getState().answer('F001', { correct: true, hintsUsed: 0 }, now);

    const p = useAppStore.getState().progress['F001'];
    expect(p).toBeDefined();
    expect(p?.seen).toBe(1);
    expect(p?.correct).toBe(1);
    expect(p?.consecutiveCorrect).toBe(1);

    // Survives a reload — i.e. it really reached disk, not just the store.
    const doc = await loadProgressDoc();
    expect(doc.progress['F001']?.correct).toBe(1);

    expect(Object.keys(useAppStore.getState().practiceDays)).toHaveLength(1);

    const queued = await outbox.all();
    expect(queued.some((m) => m.kind === 'progress')).toBe(true);
    expect(queued.some((m) => m.kind === 'practiceDay')).toBe(true);
  });

  it('records only one practice day for several answers on the same day', async () => {
    const now = Date.UTC(2026, 0, 15, 10, 0, 0);
    await useAppStore.getState().answer('F001', { correct: true, hintsUsed: 0 }, now);
    await useAppStore.getState().answer('F002', { correct: false, hintsUsed: 1 }, now + 5_000);
    expect(Object.keys(useAppStore.getState().practiceDays)).toHaveLength(1);
  });

  it('toggles a flag and stores a note', async () => {
    await useAppStore.getState().toggleFlag('F010');
    expect(useAppStore.getState().progress['F010']?.flagged).toBe(true);
    await useAppStore.getState().toggleFlag('F010');
    expect(useAppStore.getState().progress['F010']?.flagged).toBe(false);

    await useAppStore.getState().setNote('F010', 'mnemonic: eagle');
    expect(useAppStore.getState().progress['F010']?.note).toBe('mnemonic: eagle');
    const doc = await loadProgressDoc();
    expect(doc.progress['F010']?.note).toBe('mnemonic: eagle');
  });
});

/**
 * The scope-change requirement: progress must survive a state switch, in both
 * directions, without the user losing anything they earned.
 */
describe('switching Bundesland is lossless', () => {
  it('BW -> BY -> BW restores the original state progress intact', async () => {
    const t0 = Date.UTC(2026, 0, 10, 9, 0, 0);
    await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true });

    // Study one federal and one Baden-Württemberg question.
    await useAppStore.getState().answer('F001', { correct: true, hintsUsed: 0 }, t0);
    await useAppStore.getState().answer('BW01', { correct: true, hintsUsed: 0 }, t0 + 1_000);
    const bwBefore = useAppStore.getState().progress['BW01'];
    const fedBefore = useAppStore.getState().progress['F001'];
    expect(bwBefore).toBeDefined();

    // Switch to Bavaria and study a Bavarian question.
    await useAppStore.getState().switchState('BY');
    expect(useAppStore.getState().settings.state).toBe('BY');
    await useAppStore.getState().answer('BY01', { correct: true, hintsUsed: 0 }, t0 + 2_000);

    // The Baden-Württemberg row was not touched by the switch.
    expect(useAppStore.getState().progress['BW01']).toEqual(bwBefore);
    // Federal progress is shared, not duplicated per state.
    expect(useAppStore.getState().progress['F001']).toEqual(fedBefore);

    // Switch back, re-reading from disk to prove persistence rather than memory.
    await useAppStore.getState().switchState('BW');
    useAppStore.setState({ hydrated: false, progress: {} });
    await useAppStore.getState().reloadFromDb();

    const after = useAppStore.getState();
    expect(after.settings.state).toBe('BW');
    expect(after.progress['BW01']).toEqual(bwBefore);
    expect(after.progress['F001']).toEqual(fedBefore);
    // Bavaria's progress is kept too — switching away is not a delete.
    expect(after.progress['BY01']).toBeDefined();
  });

  it('re-derives the active deck to 310 questions for whichever state is selected', async () => {
    await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true });
    const bwDeck = activeDeck('BW');
    expect(bwDeck).toHaveLength(310);
    expect(bwDeck.some((q) => q.id === 'BW01')).toBe(true);
    expect(bwDeck.some((q) => q.id === 'BY01')).toBe(false);

    await useAppStore.getState().switchState('BY');
    const byDeck = activeDeck('BY');
    expect(byDeck).toHaveLength(310);
    expect(byDeck.some((q) => q.id === 'BY01')).toBe(true);
    expect(byDeck.some((q) => q.id === 'BW01')).toBe(false);
  });
});

describe('scoped reset', () => {
  it('resetCurrentState clears only the active state, keeping federal and other states', async () => {
    const t0 = Date.UTC(2026, 0, 12, 9, 0, 0);
    await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true });
    await useAppStore.getState().answer('F001', { correct: true, hintsUsed: 0 }, t0);
    await useAppStore.getState().answer('BW01', { correct: true, hintsUsed: 0 }, t0 + 1_000);
    await useAppStore.getState().switchState('BY');
    await useAppStore.getState().answer('BY01', { correct: true, hintsUsed: 0 }, t0 + 2_000);

    // Reset Bavaria while standing in Bavaria.
    const removed = await useAppStore.getState().resetCurrentState();
    expect(removed).toBeGreaterThan(0);

    const p = useAppStore.getState().progress;
    expect(p['BY01']).toBeUndefined();
    expect(p['F001']).toBeDefined();
    expect(p['BW01']).toBeDefined();
  });

  it('resetEverything clears progress but leaves the app usable', async () => {
    await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true });
    await useAppStore.getState().answer('F001', { correct: true, hintsUsed: 0 });
    await useAppStore.getState().resetEverything();
    expect(useAppStore.getState().progress['F001']).toBeUndefined();
    expect(useAppStore.getState().hydrated).toBe(true);
  });
});

describe('badges and xp', () => {
  it('keeps the first earn time when a badge is granted twice', async () => {
    const first = Date.UTC(2026, 0, 5, 8, 0, 0);
    await useAppStore.getState().grantBadge('firstSteps', first);
    await useAppStore.getState().grantBadge('firstSteps', first + 86_400_000);
    expect(useAppStore.getState().badges['firstSteps']).toBe(first);
  });

  it('accumulates xp', async () => {
    await useAppStore.getState().gainXp(10);
    await useAppStore.getState().gainXp(5);
    expect(useAppStore.getState().xp).toBe(15);
  });
});
