// jsdom has no IndexedDB; this must load before anything that opens the database.
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/i18n/useT';
import { useAppStore } from '@/store';
import { closeDb, deleteDb } from '@/lib/db';
import { buildMockPaper, buildMockResult } from '@/lib/mockExam';
import Review from './Review';

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

function TestApp({ mockId }: { readonly mockId: string }): ReactNode {
  return (
    <I18nProvider initialLocale="en">
      <MemoryRouter initialEntries={[`/review/${mockId}`]}>
        <Routes>
          <Route path="/review/:mockId" element={<Review />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>
  );
}

beforeEach(async () => {
  await freshStore();
  await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true });
});

describe('Review', () => {
  it('shows a not-found state for an unknown mockId instead of throwing', () => {
    expect(() => render(<TestApp mockId="does-not-exist" />)).not.toThrow();
    expect(screen.getByText('Page not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the dashboard' })).toBeInTheDocument();
  });

  it('renders a passed result with the correct score and pass mark', async () => {
    const startedAt = Date.UTC(2026, 0, 10, 9, 0, 0);
    const paper = buildMockPaper('BW', startedAt);
    const responses = Object.fromEntries(
      paper.slice(0, 20).map((q, i) => [q.id, { chosen: q.solution, answeredAt: startedAt + i * 1000 }]),
    );
    const result = buildMockResult({
      id: 'mock-abc',
      state: 'BW',
      startedAt,
      finishedAt: startedAt + 30 * 60_000,
      paper,
      responses,
    });
    await useAppStore.getState().finishMock(result);

    render(<TestApp mockId="mock-abc" />);

    expect(await screen.findByText('Passed')).toBeInTheDocument();
    expect(screen.getByText('20 of 33 correct')).toBeInTheDocument();
  });

  it('filters to wrong-only and skipped-only answers', async () => {
    const startedAt = Date.UTC(2026, 0, 11, 9, 0, 0);
    const paper = buildMockPaper('BW', startedAt);
    // Answer the first 17 correctly (a pass), get the next one deliberately wrong,
    // and leave everything after that untouched (skipped).
    const wrongOption = (['a', 'b', 'c', 'd'] as const).find((k) => k !== paper[17]?.solution);
    const responses: Record<string, { chosen: 'a' | 'b' | 'c' | 'd'; answeredAt: number }> = {};
    paper.slice(0, 17).forEach((q, i) => {
      responses[q.id] = { chosen: q.solution, answeredAt: startedAt + i * 1000 };
    });
    const q17 = paper[17];
    if (q17 !== undefined && wrongOption !== undefined) {
      responses[q17.id] = { chosen: wrongOption, answeredAt: startedAt + 20_000 };
    }
    const result = buildMockResult({
      id: 'mock-filters',
      state: 'BW',
      startedAt,
      finishedAt: startedAt + 40 * 60_000,
      paper,
      responses,
    });
    await useAppStore.getState().finishMock(result);

    render(<TestApp mockId="mock-filters" />);
    await screen.findByText('Passed');

    // All: every question in the paper is listed.
    expect(screen.getAllByText('Your answer:', { exact: false }).length).toBe(33);

    screen.getByRole('button', { name: 'Wrong only' }).click();
    await waitFor(() => {
      expect(screen.getAllByText('Your answer:', { exact: false }).length).toBe(1);
    });

    screen.getByRole('button', { name: 'Skipped' }).click();
    await waitFor(() => {
      expect(screen.getAllByText('Your answer:', { exact: false }).length).toBe(paper.length - 18);
    });
  });
});
