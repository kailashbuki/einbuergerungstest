// The home screen. It answers exactly one question in the first 200px — "am I
// ready for the exam?" — and everything below that is supporting detail, ordered
// by how directly it tells the user what to do next.
//
// Everything on this screen is derived, read-only state. The dashboard never
// mutates the store; the only side effect it can cause is navigation.
//
// Layout notes that matter at the 375px hard constraint:
//   * One column, full width. No side-by-side legends, no dense axis labels.
//   * The only SVG chart is the mock-score line; every other visual is HTML/CSS
//     so it mirrors under `dir="rtl"` without hand-written overrides.
//   * Only logical utilities (`ps/pe/ms/me/start/end/text-start`) are used.

import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Dot, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TooltipContentProps } from 'recharts';
import {
  CategoryBars,
  MasteryHeatmap,
  ReadinessMeter,
  StatTile,
  StreakCalendar,
  type CategoryBarRow,
  type MasteryHeatmapCell,
  type MasteryHeatmapGroup,
} from '@/components/charts';
import { STATES_BY_CODE } from '@/data/states';
import { useT } from '@/i18n/useT';
import { heimatLevelId } from '@/lib/curriculum';
import { activeDeck, federalQuestions, stateQuestions } from '@/lib/deck';
import { categoryStrength, masteryOf } from '@/lib/mastery';
import { estimatedSessionsToReady, OUT_OF, PASS_MARK, READY_SCORE, readinessScore } from '@/lib/readiness';
import { buildNemesis } from '@/lib/scheduler';
import { useActiveState, useHydrated, useMocks, usePracticeDays, useProgress, useXp } from '@/store';
import type { MockResult, Question } from '@/types';

/** Federal cells per row. 20 × ~14px fits inside a 375px viewport with the 2px gaps. */
const FEDERAL_COLUMNS = 20;
/** The 10 state questions get 5 per row, so each cell is big enough to read. */
const STATE_COLUMNS = 5;
/** How many nemesis questions to list before the "drill these" action. */
const NEMESIS_PREVIEW = 5;
/** How many past mock attempts to list. */
const MOCK_PREVIEW = 5;
const MOCK_CHART_HEIGHT = 168;
/** A single attempt is a stat, not a chart — one point is not a trend. */
const MIN_POINTS_FOR_TREND = 2;

/* ───────────────────────────── small pieces ───────────────────────────── */

function Panel({
  id,
  title,
  subtitle,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="rounded-2xl border border-line bg-surface-raised p-4">
      <h2 id={id} className="text-base font-semibold text-fg">
        {title}
      </h2>
      {subtitle !== undefined ? <p className="mt-0.5 text-xs text-fg-muted">{subtitle}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** A 44px link styled as the panel's primary next action. */
function ActionLink({ to, children }: { readonly to: string; readonly children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-fg"
    >
      {children}
    </Link>
  );
}

/** A 44px link styled as a quiet inline action. */
function QuietLink({ to, children }: { readonly to: string; readonly children: ReactNode }) {
  return (
    <Link
      to={to}
      className="-me-2 inline-flex min-h-touch items-center rounded-lg px-2 text-sm font-medium text-accent"
    >
      {children}
    </Link>
  );
}

/* ───────────────────────────── mock history ───────────────────────────── */

interface MockPoint {
  readonly attempt: number;
  readonly correct: number;
  readonly dateLabel: string;
}

function MockChartTooltip({
  active,
  label,
  points,
}: {
  readonly active: boolean;
  readonly label: string | number | undefined;
  readonly points: readonly MockPoint[];
}) {
  const { t, formatNumber } = useT();
  if (!active) return null;
  const point = points.find((p) => p.attempt === Number(label));
  if (point === undefined) return null;
  return (
    <div className="rounded-lg border border-line bg-surface-raised px-2 py-1 text-xs">
      <p className="font-medium text-fg">{point.dateLabel}</p>
      <p className="tabular-nums text-fg-muted">
        {t('common.of', { current: formatNumber(point.correct), total: formatNumber(OUT_OF) })}
      </p>
    </div>
  );
}

/**
 * Score per attempt, with the pass mark as a reference line.
 *
 * RTL: Recharts renders SVG, which does not mirror. The x-axis is attempt
 * *number* (1, 2, 3 …) rather than a date axis and is intentionally left in
 * ascending left-to-right order in every locale — that is the universal
 * convention for a plotted series, and re-mirroring it would put "attempt 1" in
 * a different place than the attempt list immediately below, which DOES mirror.
 * The list is the table view, so no value is only reachable from the SVG.
 */
function MockTrend({ points }: { readonly points: readonly MockPoint[] }) {
  const { t, formatNumber, formatList } = useT();

  const description = formatList(
    points.map((p) => `${p.dateLabel}: ${t('common.of', { current: formatNumber(p.correct), total: formatNumber(OUT_OF) })}`),
  );

  return (
    <div>
      {/* `text-fg-muted` is inherited by the axes; the series and the reference
          line override it with their own token class. No hex anywhere. */}
      <div className="w-full text-fg-muted" style={{ height: MOCK_CHART_HEIGHT }}>
        <ResponsiveContainer width="100%" height={MOCK_CHART_HEIGHT}>
          <LineChart data={[...points]} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="attempt"
              stroke="currentColor"
              tickLine={false}
              tick={{ fill: 'currentColor', fontSize: 11 }}
              tickFormatter={(value: number) => formatNumber(value)}
            />
            <YAxis
              domain={[0, OUT_OF]}
              ticks={[0, PASS_MARK, OUT_OF]}
              width={30}
              stroke="currentColor"
              tickLine={false}
              tick={{ fill: 'currentColor', fontSize: 11 }}
              tickFormatter={(value: number) => formatNumber(value)}
            />
            {/* Solid ink hairline, never dashed: this is the one number that decides pass/fail. */}
            <ReferenceLine y={PASS_MARK} className="text-fg" stroke="currentColor" strokeWidth={2} />
            <Tooltip
              content={(props: TooltipContentProps) => (
                <MockChartTooltip active={props.active} label={props.label} points={points} />
              )}
            />
            <Line
              type="linear"
              dataKey="correct"
              className="text-accent"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              isAnimationActive={false}
              activeDot={<Dot r={6} className="fill-accent stroke-surface-raised" strokeWidth={2} />}
              dot={<Dot r={4} className="fill-accent stroke-surface-raised" strokeWidth={2} />}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 flex items-center gap-1.5 text-xs text-fg-muted">
        <span aria-hidden="true" className="inline-block h-0.5 w-4 shrink-0 rounded-full bg-fg" />
        {t('dash.readiness.passMark', { mark: PASS_MARK })}
      </p>
      <p className="sr-only">{t('a11y.chartDescription', { description })}</p>
    </div>
  );
}

/* ───────────────────────────── the dashboard ──────────────────────────── */

function DashboardSkeleton({ title }: { readonly title: string }) {
  const { t } = useT();
  return (
    <div className="mx-auto w-full max-w-screen-sm p-4" aria-busy="true">
      <h1 className="text-2xl font-semibold text-fg">{title}</h1>
      <p className="sr-only">{t('common.loading')}</p>
      {/* Deliberately no numbers: showing a returning user "0 / 33" for one
          frame, before IndexedDB has been read, would be a real bug. */}
      <div className="mt-4 space-y-3">
        <div className="h-40 animate-pulse rounded-2xl bg-surface-raised" />
        <div className="grid grid-cols-2 gap-3">
          <div className="h-20 animate-pulse rounded-xl bg-surface-raised" />
          <div className="h-20 animate-pulse rounded-xl bg-surface-raised" />
          <div className="h-20 animate-pulse rounded-xl bg-surface-raised" />
          <div className="h-20 animate-pulse rounded-xl bg-surface-raised" />
        </div>
        <div className="h-56 animate-pulse rounded-2xl bg-surface-raised" />
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { t, formatNumber, formatPercent, formatDate } = useT();
  const hydrated = useHydrated();
  const state = useActiveState();
  const progress = useProgress();
  const xp = useXp();
  const mocks = useMocks();
  const practiceDays = usePracticeDays();

  const title = t('dash.title');
  const stateName = state === null ? '' : STATES_BY_CODE[state].name;

  const deck = useMemo<readonly Question[]>(() => (state === null ? [] : activeDeck(state)), [state]);

  const stats = useMemo(() => {
    let answered = 0;
    let mastered = 0;
    let seen = 0;
    let correct = 0;
    let flagged = 0;
    for (const q of deck) {
      const p = progress[q.id];
      if (p === undefined) continue;
      if (p.flagged) flagged += 1;
      if (p.seen <= 0) continue;
      answered += 1;
      seen += p.seen;
      correct += p.correct;
      if (masteryOf(p) === 'mastered') mastered += 1;
    }
    return { answered, mastered, seen, correct, flagged };
  }, [deck, progress]);

  const readiness = useMemo(() => (state === null ? null : readinessScore(state, progress)), [state, progress]);
  const sessionsToReady = useMemo(
    () => (state === null ? null : estimatedSessionsToReady(state, progress)),
    [state, progress],
  );

  const heatmapGroups = useMemo<readonly MasteryHeatmapGroup[]>(() => {
    if (state === null) return [];
    const toCell = (q: Question): MasteryHeatmapCell => ({
      id: q.id,
      number: q.number,
      bucket: masteryOf(progress[q.id]),
    });
    return [
      {
        key: 'federal',
        label: t('dash.heatmap.federal'),
        columns: FEDERAL_COLUMNS,
        cells: federalQuestions().map(toCell),
        action: { to: '/worlds', label: t('nav.worlds') },
      },
      {
        key: 'state',
        label: t('dash.heatmap.state', { state: stateName }),
        columns: STATE_COLUMNS,
        cells: stateQuestions(state).map(toCell),
        action: { to: `/level/${heimatLevelId(state)}`, label: t('level.start') },
      },
    ];
  }, [state, progress, stateName, t]);

  const categoryRows = useMemo<readonly CategoryBarRow[]>(
    () =>
      categoryStrength(deck, progress).map((row) => ({
        category: row.category,
        label: t(`category.${row.category}`),
        strength: row.strength,
        total: row.total,
        drillTo: `/drill?scope=category&category=${encodeURIComponent(row.category)}`,
      })),
    // `t` is a dependency: the labels are localized now, so switching interface
    // language must recompute them rather than leave the previous language's
    // strings on the axis.
    [deck, progress, t],
  );

  const nemesis = useMemo(() => buildNemesis(deck, progress, deck.length), [deck, progress]);

  // A mock taken in another Bundesland answered 3 different state questions, so
  // its score is not comparable. Those attempts stay in the list (labelled with
  // the state they were taken in) but never in the trend.
  const ownMocks = useMemo<readonly MockResult[]>(
    () => [...mocks].filter((m) => m.state === state).sort((a, b) => a.finishedAt - b.finishedAt),
    [mocks, state],
  );
  const recentMocks = useMemo<readonly MockResult[]>(
    () => [...mocks].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, MOCK_PREVIEW),
    [mocks],
  );
  const mockPoints = useMemo<readonly MockPoint[]>(
    () =>
      ownMocks.map((m, i) => ({
        attempt: i + 1,
        correct: m.correct,
        dateLabel: formatDate(m.finishedAt, { day: 'numeric', month: 'short' }),
      })),
    [ownMocks, formatDate],
  );

  if (!hydrated) return <DashboardSkeleton title={title} />;

  if (state === null || readiness === null) {
    return (
      <div className="mx-auto w-full max-w-screen-sm space-y-3 p-4">
        <h1 className="text-2xl font-semibold text-fg">{title}</h1>
        <p className="text-sm text-fg-muted">{t('dash.readiness.empty')}</p>
        <ActionLink to="/settings">{t('nav.settings')}</ActionLink>
      </div>
    );
  }

  const hasData = stats.answered > 0;
  const lastMock = ownMocks[ownMocks.length - 1];

  const timeToReadyText = !hasData
    ? t('dash.timeToReady.unknown')
    : sessionsToReady === null
      ? readiness.score >= READY_SCORE
        ? t('dash.timeToReady.ready')
        : t('dash.timeToReady.unknown')
      : t('dash.timeToReady.value', { count: sessionsToReady });

  return (
    <div className="mx-auto w-full max-w-screen-sm space-y-3 p-4">
      <h1 className="text-2xl font-semibold text-fg">{title}</h1>

      {/* 1 — Readiness. The hero, and the only hero on the screen. */}
      <section aria-labelledby="dash-readiness">
        <h2 id="dash-readiness" className="mb-2 text-base font-semibold text-fg">
          {t('dash.readiness.title')}
        </h2>
        <ReadinessMeter
          readiness={readiness}
          stateName={stateName}
          hasData={hasData}
          emptyAction={<ActionLink to="/worlds">{t('level.start')}</ActionLink>}
        />
      </section>

      {/* 2 — Stat tiles. Four headline numbers; no chart would say it better. */}
      <dl className="grid grid-cols-2 gap-3">
        <StatTile label={t('dash.stats.answered')} value={formatNumber(stats.answered)} detail={t('common.of', { current: formatNumber(stats.answered), total: formatNumber(deck.length) })} />
        <StatTile label={t('dash.stats.mastered')} value={formatNumber(stats.mastered)} />
        <StatTile
          label={t('dash.stats.accuracy')}
          value={stats.seen > 0 ? formatPercent(stats.correct / stats.seen) : t('common.none')}
        />
        <StatTile label={t('dash.stats.xp')} value={formatNumber(xp)} />
      </dl>

      {/* 3 — Mastery heatmap. */}
      <section aria-labelledby="dash-heatmap">
        <h2 id="dash-heatmap" className="mb-2 text-base font-semibold text-fg">
          {t('dash.heatmap.title')}
        </h2>
        <MasteryHeatmap groups={heatmapGroups} />
      </section>

      {/* 4 — Weakest topics. */}
      <Panel id="dash-categories" title={t('dash.categories.title')}>
        <CategoryBars rows={categoryRows} />
      </Panel>

      {/* 5 — Nemesis. */}
      <Panel id="dash-nemesis" title={t('dash.nemesis.title')} subtitle={t('dash.nemesis.desc')}>
        {nemesis.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('dash.nemesis.empty')}</p>
        ) : (
          <>
            <ul className="divide-y divide-line">
              {nemesis.slice(0, NEMESIS_PREVIEW).map((q) => (
                <li key={q.id} className="py-2 first:pt-0">
                  <p className="text-xs font-medium tabular-nums text-fg-muted">
                    {t('q.number', { number: q.number })}
                  </p>
                  {/* Question text is German source data, not UI copy: pin it LTR
                      so it stays readable inside an RTL interface. */}
                  <p lang="de" dir="ltr" className="line-clamp-2 text-start text-sm text-fg">
                    {q.question}
                  </p>
                </li>
              ))}
            </ul>
            <div className="mt-3">
              <ActionLink to="/drill?scope=nemesis">{t('dash.nemesis.drillThese', { count: nemesis.length })}</ActionLink>
            </div>
          </>
        )}
      </Panel>

      {/* 6 — Flagged. */}
      <Panel id="dash-flagged" title={t('dash.flagged.title')} subtitle={t('dash.flagged.desc')}>
        {stats.flagged === 0 ? (
          <p className="text-sm text-fg-muted">{t('dash.flagged.empty')}</p>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium tabular-nums text-fg">{t('dash.flagged.count', { count: stats.flagged })}</p>
            <QuietLink to="/drill?scope=flagged">{t('drill.start')}</QuietLink>
          </div>
        )}
      </Panel>

      {/* 7 — Streak calendar. */}
      <Panel id="dash-streak" title={t('dash.streak.title')}>
        <StreakCalendar practiceDays={practiceDays} />
      </Panel>

      {/* 8 — Mock history. */}
      <Panel id="dash-history" title={t('dash.history.title')}>
        {recentMocks.length === 0 ? (
          <div>
            <p className="text-sm text-fg-muted">{t('dash.history.empty')}</p>
            <div className="mt-3">
              <ActionLink to="/mock">{t('mock.start')}</ActionLink>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {lastMock !== undefined ? (
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-fg-muted">{t('dash.history.lastScore')}</p>
                  <p className="mt-0.5 text-2xl font-semibold leading-none text-fg">
                    {t('common.of', { current: formatNumber(lastMock.correct), total: formatNumber(lastMock.total) })}
                  </p>
                </div>
                <p className="shrink-0 text-xs tabular-nums text-fg-muted">
                  {t('dash.history.attempts', { count: mocks.length })}
                </p>
              </div>
            ) : null}

            {mockPoints.length >= MIN_POINTS_FOR_TREND ? <MockTrend points={mockPoints} /> : null}

            <ul className="divide-y divide-line">
              {recentMocks.map((m) => (
                <li key={m.id} className="py-2 first:pt-0">
                  <Link to={`/review/${m.id}`} className="flex min-h-touch items-center justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block text-sm text-fg">
                        {formatDate(m.finishedAt, { day: 'numeric', month: 'short', year: 'numeric' })}
                      </span>
                      {/* A score from another Bundesland is not comparable, so say which one it was. */}
                      {m.state !== state ? (
                        <span className="block text-xs text-fg-muted">{STATES_BY_CODE[m.state].name}</span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-sm font-medium tabular-nums text-fg">
                        {t('common.of', { current: formatNumber(m.correct), total: formatNumber(m.total) })}
                      </span>
                      <span className={`text-xs font-medium ${m.passed ? 'text-accent' : 'text-wrong'}`}>
                        {t(m.passed ? 'mock.passed' : 'mock.failed')}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      {/* 9 — Time to ready. */}
      <Panel id="dash-time" title={t('dash.timeToReady.title')}>
        <p className="text-lg font-semibold text-fg">{timeToReadyText}</p>
        {!hasData ? (
          <div className="mt-3">
            <ActionLink to="/worlds">{t('level.start')}</ActionLink>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
