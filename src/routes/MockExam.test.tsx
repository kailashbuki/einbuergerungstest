// jsdom has no IndexedDB; this must load before anything that opens the database.
import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/i18n/useT';
import { useAppStore } from '@/store';
import { closeDb, deleteDb } from '@/lib/db';
import MockExam from './MockExam';
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

function TestApp(): ReactNode {
  return (
    <I18nProvider initialLocale="en">
      <MemoryRouter initialEntries={['/mock']}>
        <Routes>
          <Route path="/mock" element={<MockExam />} />
          <Route path="/review/:mockId" element={<Review />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>
  );
}

beforeEach(async () => {
  await freshStore();
  sessionStorage.clear();
  await useAppStore.getState().patchSettings({ state: 'BW', onboarded: true });
});

afterEach(() => {
  sessionStorage.clear();
  vi.useRealTimers();
});

describe('MockExam', () => {
  it('starts the exam from the intro and shows no correct/incorrect feedback after answering', async () => {
    render(<TestApp />);

    expect(screen.getByText('Real exam conditions')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start exam' }));

    const optionA = await screen.findByRole('button', { name: 'Option A' });
    fireEvent.click(optionA);

    // Selection styling is allowed; correctness styling/text is not, anywhere, during the exam.
    expect(screen.queryByText(/correct answer/i)).not.toBeInTheDocument();
    expect(document.querySelectorAll('[class*="text-correct"], [class*="text-wrong"]')).toHaveLength(0);
    expect(optionA.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps Arabic translations off by default and only shows them once mockTranslations is enabled', async () => {
    await useAppStore.getState().patchSettings({ translation: 'ar', mockTranslations: false });
    render(<TestApp />);

    fireEvent.click(screen.getByRole('button', { name: 'Start exam' }));
    await screen.findByRole('button', { name: 'Option A' });
    expect(document.querySelector('[data-translation-locale="ar"]')).toBeNull();

    await act(async () => {
      await useAppStore.getState().patchSettings({ mockTranslations: true });
    });

    const block = await waitFor(() => {
      const el = document.querySelector('[data-translation-locale="ar"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(block.getAttribute('dir')).toBe('rtl');
    // The interface stays English/LTR; only the translation subtree flips.
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('submits, persists a MockResult tagged with the active Bundesland, and navigates to review', async () => {
    render(<TestApp />);

    fireEvent.click(screen.getByRole('button', { name: 'Start exam' }));
    await screen.findByRole('button', { name: 'Option A' });

    fireEvent.click(screen.getByRole('button', { name: 'Submit exam' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(useAppStore.getState().mocks).toHaveLength(1);
    });
    const [result] = useAppStore.getState().mocks;
    expect(result?.state).toBe('BW');
    expect(result?.total).toBe(33);

    await screen.findByText('Exam review');
  });

  it('auto-submits once the 60-minute timer reaches zero', async () => {
    const startedAt = Date.UTC(2026, 0, 1, 9, 0, 0);
    // Fake only `Date`, not the timer functions: `finishMock` awaits real
    // IndexedDB completion callbacks scheduled through real `setTimeout`, and
    // mixing that with faked timers is a reliable way to deadlock the test.
    // Leaving `setInterval`/`setTimeout` real means `ExamTimer`'s own 1s tick
    // still fires on the wall clock; we only need to fast-forward what
    // `Date.now()` reports to make that next real tick see an expired timer —
    // exactly the "recompute from fixed timestamps" path a backgrounded tab
    // would hit, without waiting out a real 60 minutes.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);
    render(<TestApp />);

    fireEvent.click(screen.getByRole('button', { name: 'Start exam' }));
    await screen.findByRole('button', { name: 'Option A' });

    vi.setSystemTime(startedAt + 60 * 60_000 + 2_000);

    await waitFor(
      () => {
        expect(useAppStore.getState().mocks).toHaveLength(1);
      },
      { timeout: 3_000 },
    );
    expect(useAppStore.getState().mocks[0]?.state).toBe('BW');
  });

  it('resumes an in-progress exam after being unmounted (simulating a backgrounded/reloaded tab)', async () => {
    const first = render(<TestApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Start exam' }));
    const optionA = await screen.findByRole('button', { name: 'Option A' });
    fireEvent.click(optionA);
    expect(optionA.getAttribute('aria-pressed')).toBe('true');
    first.unmount();

    render(<TestApp />);
    // No intro this time — straight back into the same question with the same answer.
    expect(screen.queryByRole('button', { name: 'Start exam' })).not.toBeInTheDocument();
    const resumedOptionA = await screen.findByRole('button', { name: 'Option A' });
    expect(resumedOptionA.getAttribute('aria-pressed')).toBe('true');
  });
});
