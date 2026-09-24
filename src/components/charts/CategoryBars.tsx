// Topic strength, weakest first — the "what do I fix next" chart.
//
// FORM. Comparing magnitude across long-named categories is a horizontal bar
// chart. It is built from HTML rows rather than a Recharts `BarChart` on purpose:
// at 375px a rotated/truncated SVG y-axis of ten category names is unreadable,
// and each row needs a real 44px "Drill this" link, which cannot live inside an
// SVG. Rows put the label on its own line above its bar, so nothing is ever
// clipped in any locale, and the whole thing mirrors under `dir="rtl"` for free.
//
// COLOUR. One series, so one hue: the accent token for every bar, with the same
// token at 10% alpha as the track. Never a value-ramp across nominal categories
// — bar length already encodes the value, and spending hue on it too would leave
// the reader nothing. And no legend box: a single series is named by the heading.
//
// The value is direct-labelled as a percentage on every row. That is normally
// over-labelling, but here the rows ARE the table view — ten of them, one number
// each, and the number is what the user acts on.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '@/i18n/useT';
import type { CategoryId } from '@/data/categories';

export interface CategoryBarRow {
  readonly category: CategoryId;
  /** Display name for the category. */
  readonly label: string;
  /** 0–1, from `categoryStrength`. */
  readonly strength: number;
  readonly total: number;
  /** `/drill?scope=category&category=…` */
  readonly drillTo: string;
}

export interface CategoryBarsProps {
  /** Weakest first — the caller passes `categoryStrength` output unchanged. */
  readonly rows: readonly CategoryBarRow[];
  /** How many rows to show before the "More" disclosure. */
  readonly collapsedCount?: number;
}

const DEFAULT_COLLAPSED_COUNT = 5;

export function CategoryBars({ rows, collapsedCount = DEFAULT_COLLAPSED_COUNT }: CategoryBarsProps) {
  const { t, formatPercent } = useT();
  const [expanded, setExpanded] = useState(false);

  if (rows.length === 0) {
    return <p className="text-sm text-fg-muted">{t('dash.categories.empty')}</p>;
  }

  const visible = expanded ? rows : rows.slice(0, collapsedCount);
  const hasMore = rows.length > collapsedCount;

  const description = rows
    .map((row) => `${row.label}: ${formatPercent(row.strength)}`)
    .join(', ');

  return (
    <div>
      <p className="text-xs font-medium text-fg-muted">{t('dash.categories.weakestFirst')}</p>

      <ul className="mt-2 divide-y divide-line">
        {visible.map((row) => (
          <li key={row.category} className="py-3 first:pt-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 text-sm font-medium text-fg">{row.label}</span>
              <span className="shrink-0 text-sm tabular-nums text-fg-muted">{formatPercent(row.strength)}</span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-[4px] bg-accent/10">
              <div
                className="h-full rounded-e-[4px] bg-accent"
                style={{ inlineSize: `${Math.min(100, Math.max(0, row.strength * 100))}%` }}
              />
            </div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-xs tabular-nums text-fg-muted">{t('worlds.levelCount', { count: row.total })}</span>
              <Link
                to={row.drillTo}
                className="-me-2 inline-flex min-h-touch items-center rounded-lg px-2 text-sm font-medium text-accent"
              >
                {t('dash.categories.drillThis')}
              </Link>
            </div>
          </li>
        ))}
      </ul>

      {hasMore ? (
        <button
          type="button"
          onClick={() => setExpanded((was) => !was)}
          aria-expanded={expanded}
          className="mt-1 inline-flex min-h-touch items-center rounded-lg text-sm font-medium text-accent"
        >
          {expanded ? t('common.less') : t('common.more')}
        </button>
      ) : null}

      {/* Text alternative: every row's value, including the ones behind "More". */}
      <p className="sr-only">{t('a11y.chartDescription', { description })}</p>
    </div>
  );
}
