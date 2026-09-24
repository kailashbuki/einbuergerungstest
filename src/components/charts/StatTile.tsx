// A single headline number.
//
// Form choice: one current value is a *stat tile*, never a one-bar bar chart.
// The tile is plain HTML (no SVG) so it mirrors under `dir="rtl"` for free and
// costs nothing to render 4-up on a 375px screen.
//
// Figures are deliberately NOT `tabular-nums`: equal-width digits make a large
// standalone value look loose. Tabular figures are reserved for columns that
// have to align vertically (the heatmap counts, the mock list).

import type { ReactNode } from 'react';

export interface StatTileProps {
  /** Already-translated label, sentence case, no trailing colon. */
  readonly label: string;
  /** Already-formatted value — callers must run it through `formatNumber`/`formatPercent`. */
  readonly value: string;
  /** Optional second line of context (already translated). */
  readonly detail?: string | undefined;
  /** Rendered before the value; use for a status glyph, never for identity-by-colour alone. */
  readonly glyph?: ReactNode;
}

/**
 * Label above, value below. The label is a `<dt>`/`<dd>` pair so a screen
 * reader reads "Answered, 128" rather than two unrelated fragments; the caller
 * supplies the surrounding `<dl>`.
 */
export function StatTile({ label, value, detail, glyph }: StatTileProps) {
  return (
    <div className="rounded-xl border border-line bg-surface-raised p-3 text-start">
      <dt className="text-xs font-medium text-fg-muted">{label}</dt>
      <dd className="mt-1 flex items-baseline gap-1.5">
        {glyph}
        <span className="text-2xl font-semibold leading-none text-fg">{value}</span>
      </dd>
      {detail !== undefined ? <p className="mt-1 text-xs text-fg-muted">{detail}</p> : null}
    </div>
  );
}
