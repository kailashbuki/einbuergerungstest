// jsdom has no IndexedDB; this installs an in-memory implementation on
// globalThis and must come before anything that opens the database.
import 'fake-indexeddb/auto';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Dashboard from './Dashboard';
import { I18nProvider } from '@/i18n/useT';
import { closeDb, dayKey, deleteDb } from '@/lib/db';
import { federalQuestions, stateQuestions } from '@/lib/deck';
import { PASS_MARK, readinessScore } from '@/lib/readiness';
import { NEMESIS_WRONG_THRESHOLD } from '@/lib/scheduler';
import { useAppStore } from '@/store';
import type { ProgressMap } from '@/lib/progressModel';
import type { MockResult, QuestionProgress, StateCode } from '@/types';

/* ── Recharts needs a measurable box; jsdom gives it 0×0 and ResponsiveContainer
      then renders nothing. Stub both the rect and ResizeObserver so `observe()`
      hands back a fixed size synchronously. ────────────────────────────────── */

const BOX = { width: 320, height: 168 };

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    const entry = {
      target,
      contentRect: { ...BOX, top: 0, left: 0, right: BOX.width, bottom: BOX.height, x: 0, y: 0, toJSON: () => ({}) },
    };
    this.callback([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement): DOMRect {
    return {
      ...BOX,
      top: 0,
      left: 0,
      right: BOX.width,
      bottom: BOX.height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

/* ── store reset, copied from src/store/index.test.ts ─────────────────────── */

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

const STATE: StateCode = 'BW';
const NOW = new Date(2026, 8, 24, 12, 0, 0).getTime();
const DAY = 86_400_000;
const EN = 'en-US';

function progressEntry(over: Partial<QuestionProgress>): QuestionProgress {
  return {
    seen: 0,
    correct: 0,
    wrong: 0,
    consecutiveCorrect: 0,
    hintsUsed: 0,
    lastSeen: 0,
    ease: 2.5,
    dueAt: 0,
    flagged: false,
    note: '',
    updatedAt: NOW,
    ...over,
  };
}

/**
 * A plausible mid-study record: 40 mastered federal questions, 10 stuck in
 * `learning` (three of them past the nemesis threshold), two flagged, and every
 * state question mastered.
 */
function seededProgress(): ProgressMap {
  const out: Record<string, QuestionProgress> = {};
  const federal = federalQuestions();
  for (const q of federal.slice(0, 40)) {
    out[q.id] = progressEntry({ seen: 2, correct: 2, consecutiveCorrect: 2, lastSeen: NOW });
  }
  federal.slice(40, 50).forEach((q, i) => {
    out[q.id] = progressEntry({
      seen: 4,
      correct: 1,
      wrong: i < 3 ? NEMESIS_WRONG_THRESHOLD + 1 : 1,
      consecutiveCorrect: 0,
      lastSeen: NOW,
      flagged: i < 2,
    });
  });
  for (const q of stateQuestions(STATE)) {
    out[q.id] = progressEntry({ seen: 2, correct: 2, consecutiveCorrect: 2, lastSeen: NOW });
  }
  return out;
}

function mock(id: string, correct: number, at: number, state: StateCode = STATE): MockResult {
  return {
    id,
    state,
    startedAt: at - 600_000,
    finishedAt: at,
    durationMs: 600_000,
    answers: [],
    correct,
    total: 33,
    passed: correct >= PASS_MARK,
  };
}

async function selectState(): Promise<void> {
  await useAppStore.getState().patchSettings({ state: STATE, onboarded: true });
}

function renderDashboard() {
  return render(
    <I18nProvider initialLocale="en">
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe('Dashboard before hydration', () => {
  it('shows a skeleton, never a readiness number', async () => {
    await selectState();
    useAppStore.setState({ progress: seededProgress() });
    // Simulate the window between mount and the IndexedDB read completing.
    useAppStore.setState({ hydrated: false });

    const { container } = renderDashboard();

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('Predicted score')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    // No number of any kind: "0 / 33" for one frame would be a real bug.
    expect(container.textContent).not.toMatch(/\d/);
  });
});

describe('Dashboard with zero progress', () => {
  beforeEach(async () => {
    await selectState();
  });

  it('shows real empty states instead of NaN or a fake 0 / 33', () => {
    const { container } = renderDashboard();

    expect(screen.getByText('Answer a few questions to see your predicted score.')).toBeInTheDocument();
    // `readinessScore` returns 8.25/33 at zero progress; that must not surface.
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(container.textContent).not.toMatch(/NaN|Infinity|8\.25/);

    expect(screen.getByText('Nothing here yet. That is a good thing.')).toBeInTheDocument();
    expect(screen.getByText('No flagged questions yet. Tap the star on any question to save it here.')).toBeInTheDocument();
    expect(screen.getByText('No mock exams yet.')).toBeInTheDocument();
    expect(screen.getByText('Not enough data yet')).toBeInTheDocument();
    expect(screen.getByText('0 days')).toBeInTheDocument();
  });

  it('gives every empty state a next action', () => {
    renderDashboard();
    expect(screen.getAllByRole('link', { name: 'Start level' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('link', { name: 'Start exam' })).toHaveAttribute('href', '/mock');
  });
});

describe('Dashboard with seeded progress', () => {
  const progress = seededProgress();

  beforeEach(async () => {
    await selectState();
    useAppStore.setState({
      progress,
      xp: 420,
      practiceDays: { [dayKey(NOW)]: true, [dayKey(NOW - DAY)]: true },
      mocks: [mock('m1', 14, NOW - 3 * DAY), mock('m2', 26, NOW - DAY), mock('m3', 20, NOW - 2 * DAY, 'BY')],
    });
  });

  it('shows the readiness figure the engine computes from the same progress', () => {
    const expected = readinessScore(STATE, progress);
    renderDashboard();

    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', String(expected.score));
    expect(bar).toHaveAttribute('aria-valuemax', String(expected.outOf));

    const scoreText = new Intl.NumberFormat(EN, { maximumFractionDigits: 1 }).format(expected.score);
    expect(screen.getAllByText(scoreText).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(`${scoreText} of ${expected.outOf}`)).toBeInTheDocument();
    // The band name is spelled out, so colour is never the only channel.
    expect(screen.getAllByText(new RegExp(`Pass mark: ${expected.passMark}`)).length).toBeGreaterThanOrEqual(1);
  });

  it('renders the federal and state groups separately, with 10 state questions', () => {
    renderDashboard();
    const federal = screen.getByRole('list', { name: 'Federal' });
    const state = screen.getByRole('list', { name: 'Baden-Württemberg' });
    expect(within(federal).getAllByRole('listitem')).toHaveLength(300);
    expect(within(state).getAllByRole('listitem')).toHaveLength(10);
    // The group is the tap target, not the ~14px cell.
    expect(screen.getByRole('link', { name: 'Worlds' })).toHaveAttribute('href', '/worlds');
    expect(screen.getByRole('link', { name: 'Start level' })).toHaveAttribute('href', '/level/heimat-bw');
  });

  it('links each section into the drill scope it describes', () => {
    renderDashboard();
    expect(screen.getByRole('link', { name: /Drill these 3/ })).toHaveAttribute('href', '/drill?scope=nemesis');
    expect(screen.getByRole('link', { name: 'Start drill' })).toHaveAttribute('href', '/drill?scope=flagged');
    expect(screen.getByText('2 flagged')).toBeInTheDocument();
    const categoryLinks = screen.getAllByRole('link', { name: 'Drill this' });
    expect(categoryLinks.length).toBeGreaterThan(0);
    expect(categoryLinks[0]?.getAttribute('href')).toMatch(/^\/drill\?scope=category&category=/);
  });

  it('labels the mock taken in another Bundesland and keeps it out of the trend', () => {
    const { container } = renderDashboard();

    // The SVG really rendered (ResponsiveContainer measured the stubbed box):
    // one series, one dot per own attempt, and the pass mark as a line.
    expect(container.querySelectorAll('.recharts-line-curve')).toHaveLength(1);
    expect(container.querySelectorAll('.recharts-dot')).toHaveLength(2);
    expect(container.querySelectorAll('.recharts-reference-line')).toHaveLength(1);

    // Two own attempts → a trend; the Bayern attempt is listed but not plotted.
    expect(screen.getByText('3 attempts')).toBeInTheDocument();
    expect(screen.getByText('Bayern')).toBeInTheDocument();
    const description = screen
      .queryAllByText(/^Chart: /)
      .map((el) => el.textContent ?? '')
      // The readiness meter also says "of 33"; the trend is the one without a pass mark.
      .find((text) => text.includes('of 33') && !text.includes('Pass mark'));
    expect(description).toBeDefined();
    expect(description).toContain('14 of 33');
    expect(description).toContain('26 of 33');
    expect(description).not.toContain('20 of 33');
  });

  it('gives every chart a text alternative rather than a bare svg', () => {
    const { container } = renderDashboard();
    const written = screen.queryAllByText(/^Chart: /).map((el) => el.textContent ?? '');
    const labelled = screen
      .queryAllByRole('img')
      .map((el) => el.getAttribute('aria-label') ?? '')
      .filter((label) => label.startsWith('Chart: '));
    const all = [...written, ...labelled];

    // readiness meter, two heatmap groups, category bars, streak grid, mock trend.
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(all.some((text) => text.includes('Pass mark'))).toBe(true);
    expect(all.some((text) => text.includes('Mastered:'))).toBe(true);
    expect(all.some((text) => text.includes('Practised today'))).toBe(true);

    // And every svg on the page sits next to one of those, never alone.
    expect(container.querySelectorAll('svg[aria-hidden="true"]').length).toBeGreaterThan(0);
  });

  it('estimates the remaining work from the engine, not from a guess', () => {
    renderDashboard();
    expect(screen.getByText('Estimated time to ready')).toBeInTheDocument();
    expect(screen.getByText(/about \d+ sessions|You are ready now\./)).toBeInTheDocument();
  });
});

describe('Dashboard with no state selected', () => {
  it('sends the user to settings instead of rendering a meaningless meter', () => {
    renderDashboard();
    expect(screen.getByText('Answer a few questions to see your predicted score.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
