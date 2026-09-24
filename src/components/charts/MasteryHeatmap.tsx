// All 310 active questions as a grid of mastery cells.
//
// FORM. Magnitude over a grid is a heatmap. It is built from CSS grid divs, not
// SVG, for two reasons: 310 SVG rects with individual accessible names is worse
// for assistive tech than 310 list items, and a div grid mirrors under
// `dir="rtl"` on its own (the columns reverse, which is what an RTL reader
// expects of a reading-order grid).
//
// COLOUR — and why colour is not enough here. The four mastery tokens were run
// through the dataviz palette validator against both surfaces:
//
//   light  #948A7A/#D68C2D/#3A85AD/#1F6F54 on #FFFFFF
//     chroma floor FAIL (taupe reads gray), normal-vision floor FAIL
//     (marigold↔taupe ΔE 12.8 < 15), contrast WARN (marigold 2.75:1)
//   dark   #8A8072/#E6A54A/#60AAD6/#5CC79E on #262320
//     lightness band FAIL, chroma floor FAIL,
//     normal-vision floor FAIL (mastered↔familiar ΔE 13.4 < 15)
//
// Those tokens are owned by the design system and are not mine to re-step, so
// the finding is discharged the way the skill requires: with mandatory secondary
// encoding plus a value table. Every cell therefore carries THREE channels —
//
//   hue (bucket token) + mark size (34% → 100% of the cell, ordered by bucket)
//   + shape (a dot for `new`, a square for everything learned)
//
// — so the grid still reads correctly in greyscale, under full CVD, and for the
// sub-3:1 marigold. The per-group legend below each grid doubles as the table
// view: every bucket's exact count is visible text, so no value is gated behind
// colour or a hover.
//
// TAP TARGETS. `dash.heatmap.hint` imagines tapping a cell to practise that one
// question, but (a) 20 columns inside 375px makes a cell ~14px, far under the
// 44px rule, and (b) the router has no per-question route at all — the finest
// destination that exists is a level. So the *group* is the tap target: each
// group header carries a 44px-min link to where those questions actually live
// (the federal worlds; the Heimat level). Cells are inert, labelled, and
// readable — they inform, the header navigates.

import { Link } from 'react-router-dom';
import { useT } from '@/i18n/useT';
import { MASTERY_BUCKETS } from '@/lib/mastery';
import type { MasteryCounts } from '@/lib/mastery';
import type { MasteryBucket, QuestionId } from '@/types';

interface BucketMark {
  readonly fill: string;
  /** Ordered by bucket: the mark grows as mastery grows. The non-colour channel. */
  readonly size: string;
  /** Second non-colour channel: `new` is a dot, learned buckets are squares. */
  readonly shape: string;
}

const BUCKET_MARKS: Readonly<Record<MasteryBucket, BucketMark>> = {
  new: { fill: 'bg-new/40', size: '34%', shape: 'rounded-full' },
  learning: { fill: 'bg-learning', size: '58%', shape: 'rounded-[1px]' },
  familiar: { fill: 'bg-familiar', size: '80%', shape: 'rounded-[1px]' },
  mastered: { fill: 'bg-mastered', size: '100%', shape: 'rounded-[1px]' },
};

export interface MasteryHeatmapCell {
  readonly id: QuestionId;
  /** The number the user sees on the question itself. */
  readonly number: number;
  readonly bucket: MasteryBucket;
}

export interface MasteryHeatmapGroupAction {
  readonly to: string;
  /** Already translated. */
  readonly label: string;
}

export interface MasteryHeatmapGroup {
  readonly key: string;
  /** Already translated (or a proper noun, e.g. the Bundesland name). */
  readonly label: string;
  readonly cells: readonly MasteryHeatmapCell[];
  /** Grid columns. 20 for the 300 federal questions, 5 for the 10 state ones. */
  readonly columns: number;
  readonly action?: MasteryHeatmapGroupAction | undefined;
}

export interface MasteryHeatmapProps {
  readonly groups: readonly MasteryHeatmapGroup[];
}

function countBuckets(cells: readonly MasteryHeatmapCell[]): MasteryCounts {
  let bNew = 0;
  let learning = 0;
  let familiar = 0;
  let mastered = 0;
  for (const cell of cells) {
    switch (cell.bucket) {
      case 'new':
        bNew += 1;
        break;
      case 'learning':
        learning += 1;
        break;
      case 'familiar':
        familiar += 1;
        break;
      case 'mastered':
        mastered += 1;
        break;
    }
  }
  return { new: bNew, learning, familiar, mastered };
}

/** The legend swatch repeats the size + shape encoding so it teaches the grid. */
function BucketSwatch({ bucket }: { readonly bucket: MasteryBucket }) {
  const mark = BUCKET_MARKS[bucket];
  return (
    <span aria-hidden="true" className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      <span className={`${mark.fill} ${mark.shape}`} style={{ inlineSize: mark.size, blockSize: mark.size }} />
    </span>
  );
}

function HeatmapGroup({ group }: { readonly group: MasteryHeatmapGroup }) {
  const { t, formatNumber } = useT();
  const counts = countBuckets(group.cells);
  const gridId = `heatmap-${group.key}`;

  const description = MASTERY_BUCKETS.map(
    (bucket) => `${t(`mastery.${bucket}`)}: ${formatNumber(counts[bucket])}`,
  ).join(', ');

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h3 id={gridId} className="text-sm font-medium text-fg">
          {group.label}
        </h3>
        {group.action !== undefined ? (
          <Link
            to={group.action.to}
            className="-me-2 inline-flex min-h-touch items-center rounded-lg px-2 text-sm font-medium text-accent"
          >
            {group.action.label}
          </Link>
        ) : null}
      </div>

      {/* 2px gap in the surface colour is what separates touching cells — never
          a stroke around each one. */}
      <ul
        aria-labelledby={gridId}
        className="mt-2 grid gap-[2px]"
        style={{ gridTemplateColumns: `repeat(${group.columns}, minmax(0, 1fr))` }}
      >
        {group.cells.map((cell) => {
          const mark = BUCKET_MARKS[cell.bucket];
          const label = t('a11y.masteryCell', { number: cell.number, state: t(`mastery.${cell.bucket}`) });
          return (
            <li
              key={cell.id}
              aria-label={label}
              title={label}
              className="flex aspect-square items-center justify-center rounded-[2px] bg-surface"
            >
              <span
                aria-hidden="true"
                className={`${mark.fill} ${mark.shape}`}
                style={{ inlineSize: mark.size, blockSize: mark.size }}
              />
            </li>
          );
        })}
      </ul>

      {/* Legend + value table in one: swatch, name, exact count. */}
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {MASTERY_BUCKETS.map((bucket) => (
          <li key={bucket} className="flex items-center gap-1.5 text-xs text-fg-muted">
            <BucketSwatch bucket={bucket} />
            <span>{t(`mastery.${bucket}`)}</span>
            <span className="font-medium tabular-nums text-fg">{formatNumber(counts[bucket])}</span>
          </li>
        ))}
      </ul>

      <p className="sr-only">{t('a11y.chartDescription', { description: `${group.label} — ${description}` })}</p>
    </div>
  );
}

export function MasteryHeatmap({ groups }: MasteryHeatmapProps) {
  return (
    <div className="space-y-5 rounded-2xl border border-line bg-surface-raised p-4">
      {groups.map((group) => (
        <HeatmapGroup key={group.key} group={group} />
      ))}
    </div>
  );
}
