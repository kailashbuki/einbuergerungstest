// Practice days, as a calendar.
//
// FORM. Weeks are ROWS and weekdays are COLUMNS — the ordinary calendar layout,
// not the GitHub contribution strip. That is a deliberate RTL decision: time then
// flows top-to-bottom (direction-neutral) while the weekday columns are laid out
// by the writing direction, so under `dir="rtl"` the week correctly starts on the
// right. A horizontal week axis would have to be mirrored by hand and would read
// backwards in Arabic.
//
// The first column is `firstDayOfWeek()` from the locale, not a hardcoded Monday:
// en-US starts Sunday, every other locale we ship starts Monday.
//
// COLOUR. Two states, so this is status, not a scale: practised = accent fill,
// not practised = an empty outlined cell. Colour is not the only channel —
// practised cells are *filled* (fill vs outline survives greyscale and CVD) and
// every cell shows its day number.
//
// A11Y. The grid itself is one `role="img"` with a summary label rather than 42
// separately-announced cells: the conclusion a sighted reader draws is "I am on a
// 5-day streak, my best is 9, and I have practised today", so that is exactly
// what the label says. The same three facts are also on screen as text.

import { useT } from '@/i18n/useT';
import { dayKey } from '@/lib/db';
import type { PracticeDays } from '@/types';

const DAYS_PER_WEEK = 7;
const DEFAULT_WEEKS = 6;

/** A `YYYY-MM-DD` key as a whole number of days, so streaks are DST-proof. */
function dayNumberOfKey(key: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) return null;
  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined) return null;
  return Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86_400_000;
}

/** Local midnight `n` days before `from`. */
function shiftDays(from: number, n: number): Date {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

function countBack(practiceDays: PracticeDays, from: Date): number {
  let streak = 0;
  for (;;) {
    const d = new Date(from);
    d.setDate(d.getDate() - streak);
    if (practiceDays[dayKey(d.getTime())] !== true) return streak;
    streak += 1;
  }
}

/**
 * Consecutive days up to today — or up to yesterday when today has not been
 * practised yet, because a streak is not broken until the day is actually over.
 */
export function currentStreak(practiceDays: PracticeDays, today: number): number {
  const start = shiftDays(today, 0);
  if (practiceDays[dayKey(start.getTime())] === true) return countBack(practiceDays, start);
  return countBack(practiceDays, shiftDays(today, 1));
}

/** Longest run anywhere in the record, not just inside the visible window. */
export function bestStreak(practiceDays: PracticeDays): number {
  const numbers = Object.keys(practiceDays)
    .filter((key) => practiceDays[key] === true)
    .map(dayNumberOfKey)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);

  let best = 0;
  let run = 0;
  let previous: number | null = null;
  for (const n of numbers) {
    run = previous !== null && n === previous + 1 ? run + 1 : 1;
    if (run > best) best = run;
    previous = n;
  }
  return best;
}

export interface StreakCalendarProps {
  readonly practiceDays: PracticeDays;
  /** Injectable so tests are not clock-dependent. */
  readonly today?: number;
  readonly weeks?: number;
}

export function StreakCalendar({ practiceDays, today = Date.now(), weeks = DEFAULT_WEEKS }: StreakCalendarProps) {
  const { t, formatNumber, formatDate, formatList, firstDayOfWeek } = useT();

  const first = firstDayOfWeek();
  const end = shiftDays(today, 0);
  // Pad forward to the end of the current week so "today" never sits in a
  // half-row, then walk back `weeks * 7` days from there.
  const trailing = (DAYS_PER_WEEK - 1 - ((end.getDay() - first + DAYS_PER_WEEK) % DAYS_PER_WEEK));
  const total = weeks * DAYS_PER_WEEK;
  const days: readonly Date[] = Array.from({ length: total }, (_, i) =>
    shiftDays(end.getTime(), total - 1 - trailing - i),
  );

  const weekdayLabels: readonly string[] = Array.from({ length: DAYS_PER_WEEK }, (_, i) => {
    // 2024-01-07 was a Sunday, so offsetting from it gives any weekday.
    const reference = new Date(2024, 0, 7 + ((first + i) % DAYS_PER_WEEK));
    return formatDate(reference, { weekday: 'narrow' });
  });

  const practisedToday = practiceDays[dayKey(end.getTime())] === true;
  const current = currentStreak(practiceDays, today);
  const best = bestStreak(practiceDays);

  const summary = formatList([
    t('dash.streak.days', { count: current }),
    t('dash.streak.best', { count: best }),
    t(practisedToday ? 'dash.streak.today' : 'dash.streak.notToday'),
  ]);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-2xl font-semibold leading-none text-fg">{t('dash.streak.days', { count: current })}</p>
        <p className="shrink-0 text-xs tabular-nums text-fg-muted">{t('dash.streak.best', { count: best })}</p>
      </div>
      <p className={`mt-1 text-sm ${practisedToday ? 'text-accent' : 'text-fg-muted'}`}>
        {t(practisedToday ? 'dash.streak.today' : 'dash.streak.notToday')}
      </p>

      <div className="mt-3" role="img" aria-label={t('a11y.chartDescription', { description: summary })}>
        <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium text-fg-muted">
          {weekdayLabels.map((label, i) => (
            <span key={`${label}-${i}`} aria-hidden="true">
              {label}
            </span>
          ))}
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {days.map((date) => {
            const key = dayKey(date.getTime());
            const isFuture = date.getTime() > end.getTime();
            const practised = practiceDays[key] === true;
            const classes = isFuture
              ? 'border border-line/50 text-fg-muted/40'
              : practised
                ? 'bg-accent text-accent-fg'
                : 'border border-line text-fg-muted';
            return (
              <span
                key={key}
                aria-hidden="true"
                className={`flex aspect-square items-center justify-center rounded-md text-[11px] tabular-nums ${classes}`}
              >
                {formatNumber(date.getDate())}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
