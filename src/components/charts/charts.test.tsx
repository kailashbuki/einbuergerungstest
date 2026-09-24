// jsdom has no IndexedDB, and `@/lib/db` is imported transitively by
// StreakCalendar (`dayKey`); this installs an in-memory implementation on
// globalThis and must come before anything that opens the database.
import 'fake-indexeddb/auto';
import { render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CategoryBars, MasteryHeatmap, ReadinessMeter, StatTile, StreakCalendar, bestStreak, currentStreak } from './index';
import type { CategoryBarRow, MasteryHeatmapCell, MasteryHeatmapGroup } from './index';
import { I18nProvider } from '@/i18n/useT';
import { dayKey } from '@/lib/db';
import { PASS_MARK, readinessScore } from '@/lib/readiness';
import type { MasteryBucket, PracticeDays } from '@/types';

function renderChart(ui: ReactElement) {
  return render(
    <I18nProvider initialLocale="en">
      <MemoryRouter>{ui}</MemoryRouter>
    </I18nProvider>,
  );
}

/** Everything that claims to be a chart must ship one of these. */
function chartDescriptions(): readonly string[] {
  return screen
    .queryAllByText(/^Chart: /)
    .map((el) => el.textContent ?? '')
    .concat(
      screen
        .queryAllByRole('img')
        .map((el) => el.getAttribute('aria-label') ?? '')
        .filter((label) => label.startsWith('Chart: ')),
    );
}

describe('StatTile', () => {
  it('pairs the label with the value so a screen reader reads them together', () => {
    renderChart(
      <dl>
        <StatTile label="Answered" value="128" detail="128 of 310" />
      </dl>,
    );
    const term = screen.getByText('Answered');
    expect(term.tagName).toBe('DT');
    expect(screen.getByText('128').closest('dd')).not.toBeNull();
    expect(screen.getByText('128 of 310')).toBeInTheDocument();
  });
});

describe('ReadinessMeter', () => {
  const readiness = readinessScore('BW', {});

  it('shows an encouraging empty state with no score when there is no data', () => {
    const { container } = renderChart(
      <ReadinessMeter readiness={readiness} stateName="Baden-Württemberg" hasData={false} emptyAction={<button type="button">Start</button>} />,
    );
    expect(screen.getByText('Answer a few questions to see your predicted score.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    // The engine returns 8.25/33 for a blank slate; presenting that as a
    // prediction would be a lie, so no figure and no meter may appear.
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('Predicted score')).toBeNull();
    expect(container.textContent).not.toMatch(/8\.25|NaN/);
  });

  it('carries the pass mark as a visible reference, not a colour change', () => {
    const seeded = readinessScore('BW', {});
    renderChart(<ReadinessMeter readiness={seeded} stateName="Baden-Württemberg" hasData />);
    // The label appears both under the reference line and inside the text
    // alternative, so both channels are present.
    expect(screen.getAllByText(new RegExp(`Pass mark: ${PASS_MARK}`)).length).toBeGreaterThanOrEqual(1);
  });

  it('exposes a text alternative carrying the same conclusion as the meter', () => {
    renderChart(<ReadinessMeter readiness={readiness} stateName="Baden-Württemberg" hasData />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuemax', String(readiness.outOf));
    expect(bar).toHaveAttribute('aria-valuenow', String(readiness.score));
    const [description] = chartDescriptions();
    expect(description).toBeDefined();
    expect(description).toContain(`of ${readiness.outOf}`);
    expect(description).toContain(`Pass mark: ${PASS_MARK}`);
  });
});

describe('MasteryHeatmap', () => {
  function cells(count: number, bucket: MasteryBucket, offset = 0): readonly MasteryHeatmapCell[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `F${String(offset + i + 1).padStart(3, '0')}`,
      number: offset + i + 1,
      bucket,
    }));
  }

  const groups: readonly MasteryHeatmapGroup[] = [
    {
      key: 'federal',
      label: 'Federal',
      columns: 20,
      cells: [...cells(4, 'mastered'), ...cells(2, 'new', 4)],
      action: { to: '/worlds', label: 'Worlds' },
    },
    { key: 'state', label: 'Baden-Württemberg', columns: 5, cells: cells(10, 'learning', 300) },
  ];

  it('renders each group as its own grid', () => {
    renderChart(<MasteryHeatmap groups={groups} />);
    expect(within(screen.getByRole('list', { name: 'Federal' })).getAllByRole('listitem')).toHaveLength(6);
    expect(within(screen.getByRole('list', { name: 'Baden-Württemberg' })).getAllByRole('listitem')).toHaveLength(10);
  });

  it('labels every cell with its question number and bucket', () => {
    renderChart(<MasteryHeatmap groups={groups} />);
    expect(screen.getByLabelText('Question 1, Mastered')).toBeInTheDocument();
    expect(screen.getByLabelText('Question 5, New')).toBeInTheDocument();
    expect(screen.getByLabelText('Question 301, Learning')).toBeInTheDocument();
  });

  it('makes the group header the navigation target, since a cell cannot be 44px', () => {
    renderChart(<MasteryHeatmap groups={groups} />);
    expect(screen.getByRole('link', { name: 'Worlds' })).toHaveAttribute('href', '/worlds');
    // Cells are inert by design — no link inside the grid itself.
    expect(within(screen.getByRole('list', { name: 'Federal' })).queryByRole('link')).toBeNull();
  });

  it('exposes a text alternative and a visible count per bucket, so colour is never load-bearing', () => {
    renderChart(<MasteryHeatmap groups={groups} />);
    const descriptions = chartDescriptions();
    expect(descriptions).toHaveLength(2);
    expect(descriptions[0]).toContain('Federal');
    expect(descriptions[0]).toContain('Mastered: 4');
    expect(descriptions[0]).toContain('New: 2');
    expect(descriptions[1]).toContain('Learning: 10');
  });
});

describe('CategoryBars', () => {
  const rows: readonly CategoryBarRow[] = [
    { category: 'elections', label: 'Elections', strength: 0.1, total: 18, drillTo: '/drill?scope=category&category=elections' },
    { category: 'constitution', label: 'Constitution', strength: 0.25, total: 14, drillTo: '/drill?scope=category&category=constitution' },
    { category: 'general', label: 'General', strength: 0.4, total: 229, drillTo: '/drill?scope=category&category=general' },
    { category: 'federal-system', label: 'Federal System', strength: 0.5, total: 11, drillTo: '/drill?scope=category&category=federal-system' },
    { category: 'law-governance', label: 'Law & Governance', strength: 0.6, total: 33, drillTo: '/drill?scope=category&category=law-governance' },
    { category: 'rights-freedoms', label: 'Rights & Freedoms', strength: 0.9, total: 2, drillTo: '/drill?scope=category&category=rights-freedoms' },
  ];

  it('shows a real empty state rather than an axis with nothing on it', () => {
    renderChart(<CategoryBars rows={[]} />);
    expect(screen.getByText('No topic data yet.')).toBeInTheDocument();
  });

  it('direct-labels each bar and links into a category drill', () => {
    renderChart(<CategoryBars rows={rows} />);
    expect(screen.getByText('Elections')).toBeInTheDocument();
    expect(screen.getByText('10%')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Drill this' });
    expect(links[0]).toHaveAttribute('href', '/drill?scope=category&category=elections');
  });

  it('collapses to five rows and discloses the rest', () => {
    renderChart(<CategoryBars rows={rows} />);
    expect(screen.queryByText('Rights & Freedoms')).toBeNull();
    const more = screen.getByRole('button', { name: 'More' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(screen.getByText('Rights & Freedoms')).toBeInTheDocument();
  });

  it('exposes a text alternative listing every row, including the collapsed ones', () => {
    renderChart(<CategoryBars rows={rows} />);
    const [description] = chartDescriptions();
    expect(description).toBeDefined();
    expect(description).toContain('Elections: 10%');
    expect(description).toContain('Rights & Freedoms: 90%');
  });
});

describe('streak maths', () => {
  const day = 86_400_000;
  const today = new Date(2026, 8, 24, 12, 0, 0).getTime();

  function daysAgo(...offsets: readonly number[]): PracticeDays {
    const out: Record<string, true> = {};
    for (const n of offsets) out[dayKey(today - n * day)] = true;
    return out;
  }

  it('counts a run that ends today', () => {
    expect(currentStreak(daysAgo(0, 1, 2), today)).toBe(3);
  });

  it('does not break the streak until the day is actually over', () => {
    expect(currentStreak(daysAgo(1, 2, 3), today)).toBe(3);
  });

  it('is zero once a whole day has been missed', () => {
    expect(currentStreak(daysAgo(2, 3), today)).toBe(0);
  });

  it('finds the best run anywhere in the record', () => {
    expect(bestStreak(daysAgo(0, 1, 20, 21, 22, 23))).toBe(4);
  });

  it('ignores keys that are not day keys', () => {
    expect(bestStreak({ nonsense: true } as unknown as PracticeDays)).toBe(0);
  });
});

describe('StreakCalendar', () => {
  const day = 86_400_000;
  const today = new Date(2026, 8, 24, 12, 0, 0).getTime();
  const practiceDays: PracticeDays = {
    [dayKey(today)]: true,
    [dayKey(today - day)]: true,
    [dayKey(today - 2 * day)]: true,
  };

  it('states the streak in words as well as in the grid', () => {
    renderChart(<StreakCalendar practiceDays={practiceDays} today={today} />);
    expect(screen.getByText('3 days')).toBeInTheDocument();
    expect(screen.getByText('Best: 3 days')).toBeInTheDocument();
    expect(screen.getByText('Practised today')).toBeInTheDocument();
  });

  it('says so when today has not been practised yet', () => {
    renderChart(<StreakCalendar practiceDays={{}} today={today} />);
    expect(screen.getByText('Not practised today')).toBeInTheDocument();
    expect(screen.getByText('0 days')).toBeInTheDocument();
  });

  it('exposes one text alternative for the whole grid instead of 42 cells', () => {
    renderChart(<StreakCalendar practiceDays={practiceDays} today={today} weeks={6} />);
    const grid = screen.getByRole('img');
    const label = grid.getAttribute('aria-label') ?? '';
    expect(label).toContain('Chart: ');
    expect(label).toContain('3 days');
    expect(label).toContain('Practised today');
    // Weeks are rows, weekdays are columns: 6 × 7 cells plus 7 weekday headings.
    expect(grid.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(6 * 7 + 7);
  });
});
