// The one number the dashboard leads with: predicted exam score out of 33.
//
// FORM. A single ratio against a limit is a *meter*, not a chart — so this is a
// hero figure plus one horizontal track, built from plain HTML. Two consequences
// worth stating:
//
//   * No SVG, so it mirrors under `dir="rtl"` automatically. The fill grows from
//     the inline-start edge and the pass-mark caption sits inline-start of its
//     own marker, both via logical properties (`insetInlineStart`, `inlineSize`,
//     `ps-*`), so in Arabic the bar fills right-to-left with no extra code.
//   * The pass mark is a *reference line*, not a colour change. "17 to pass" is
//     the single fact that decides whether the user books the exam, so it gets
//     an ink hairline on the track and a visible label. Band colour is the
//     second channel, never the only one: the band name is always spelled out
//     and carries a glyph, because the app's status hues sit close together
//     under simulated CVD (see the note in MasteryHeatmap).
//
// COLOUR. Fill = the band's status token; track = the same token at 15% alpha,
// i.e. a lighter step of the same ramp, so state reads across the whole bar.
// Only semantic tokens, no literals.

import type { ReactNode } from 'react';
import { useT } from '@/i18n/useT';
import type { Readiness, ReadinessBand } from '@/lib/readiness';

interface BandStyle {
  /** Filled portion of the track. */
  readonly fill: string;
  /** Unfilled portion: the same hue, lighter. */
  readonly track: string;
  /** Glyph colour. Text never wears the data colour — only the glyph does. */
  readonly glyph: string;
}

const BAND_STYLES: Readonly<Record<ReadinessBand, BandStyle>> = {
  notReady: { fill: 'bg-wrong', track: 'bg-wrong/15', glyph: 'text-wrong' },
  borderline: { fill: 'bg-learning', track: 'bg-learning/15', glyph: 'text-learning' },
  ready: { fill: 'bg-accent', track: 'bg-accent/15', glyph: 'text-accent' },
  solid: { fill: 'bg-mastered', track: 'bg-mastered/15', glyph: 'text-mastered' },
};

const READY_BANDS: readonly ReadinessBand[] = ['ready', 'solid'];

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Status is never colour-alone: every band ships with this glyph plus its name. */
function BandGlyph({ band, className }: { readonly band: ReadinessBand; readonly className: string }) {
  const isReady = READY_BANDS.includes(band);
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="10" cy="10" r="8" />
      {isReady ? (
        <path d="M6.2 10.4 8.8 13l5-5.6" />
      ) : (
        <>
          <path d="M10 6v4.5" />
          <path d="M10 13.8h.01" />
        </>
      )}
    </svg>
  );
}

export interface ReadinessMeterProps {
  readonly readiness: Readiness;
  /** German name of the selected Bundesland, for `dash.readiness.explain`. */
  readonly stateName: string;
  /**
   * False when the user has answered nothing at all. `readinessScore` still
   * returns 8.25/33 in that case (four options, blind guess) and presenting it
   * as a prediction would be a lie, so we show the empty state instead.
   */
  readonly hasData: boolean;
  /** Rendered under the empty state as the "where do I start" action. */
  readonly emptyAction?: ReactNode;
}

export function ReadinessMeter({ readiness, stateName, hasData, emptyAction }: ReadinessMeterProps) {
  const { t, formatNumber } = useT();
  const { score, outOf, passMark, band } = readiness;
  const style = BAND_STYLES[band];

  const scoreFraction = clampFraction(score / outOf);
  const passFraction = clampFraction(passMark / outOf);
  const scoreText = formatNumber(score, { maximumFractionDigits: 1 });
  const bandLabel = t(`dash.readiness.band.${band}`);
  const passLabel = t('dash.readiness.passMark', { mark: passMark });

  if (!hasData) {
    return (
      <div className="rounded-2xl border border-line bg-surface-raised p-4">
        <p className="text-base text-fg">{t('dash.readiness.empty')}</p>
        <p className="mt-2 text-sm text-fg-muted">{passLabel}</p>
        {emptyAction !== undefined ? <div className="mt-3">{emptyAction}</div> : null}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-line bg-surface-raised p-4">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-fg-muted">{t('dash.readiness.predicted')}</p>
          {/* Hero figure: the score alone, so it never overflows 375px in the
              longer locales ("33 üzerinden 24,3" would). The full sentence is
              the caption directly underneath. */}
          <p className="mt-1 text-5xl font-semibold leading-none text-fg">{scoreText}</p>
          <p className="mt-1 text-sm text-fg-muted">
            {t('dash.readiness.outOf', { score: scoreText, total: formatNumber(outOf) })}
          </p>
        </div>
        <p className="flex shrink-0 basis-2/5 items-center justify-end gap-1.5 text-sm font-medium text-fg">
          <BandGlyph band={band} className={`h-5 w-5 shrink-0 ${style.glyph}`} />
          <span className="text-end">{bandLabel}</span>
        </p>
      </div>

      <div className="relative mt-5">
        <div className={`relative h-3 w-full overflow-hidden rounded-[4px] ${style.track}`}>
          {/* Square at the baseline, 4px rounded at the data end. */}
          <div
            className={`absolute inset-y-0 start-0 rounded-e-[4px] ${style.fill}`}
            style={{ inlineSize: `${scoreFraction * 100}%` }}
          />
        </div>
        {/* The pass mark: an ink hairline across the track, not a colour change. */}
        <div
          aria-hidden="true"
          className="absolute -inset-y-1 w-0.5 rounded-full bg-fg"
          style={{ insetInlineStart: `${passFraction * 100}%` }}
        />
      </div>

      {/* Caption for the reference line. A flex spacer positions it instead of a
          transform, because `flex-basis` follows the writing direction and
          `translateX` does not. */}
      <div className="mt-2 flex text-xs">
        <div aria-hidden="true" className="shrink-0" style={{ flexBasis: `${passFraction * 100}%` }} />
        <span className="min-w-0 ps-1 font-medium text-fg">{passLabel}</span>
      </div>

      <div className="mt-1 flex justify-between text-xs tabular-nums text-fg-muted">
        <span>{formatNumber(0)}</span>
        <span>{formatNumber(outOf)}</span>
      </div>

      <p className="mt-3 text-sm text-fg-muted">{t('dash.readiness.explain', { state: stateName })}</p>

      {/* Text alternative. A sighted reader concludes "24 of 33, above the 17
          needed, Ready"; this says exactly that. */}
      <p className="sr-only">
        {t('a11y.chartDescription', {
          description: `${t('dash.readiness.outOf', { score: scoreText, total: formatNumber(outOf) })}. ${passLabel}. ${bandLabel}.`,
        })}
      </p>
      <p
        className="sr-only"
        role="progressbar"
        aria-label={t('a11y.progressBar', { percent: Math.round(scoreFraction * 100) })}
        aria-valuemin={0}
        aria-valuemax={outOf}
        aria-valuenow={score}
        aria-valuetext={t('dash.readiness.outOf', { score: scoreText, total: formatNumber(outOf) })}
      />
    </div>
  );
}
