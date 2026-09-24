// One row in the Settings list: a label (+ optional description) on the
// start side and a control (usually a `<Toggle>`) on the end side. This is
// the layout most likely to break under `dir="rtl"`, so it relies entirely on
// flexbox main-axis placement (which is direction-aware by the CSS spec)
// rather than any physical left/right utility.

import type { ReactNode } from 'react';

export interface SettingRowProps {
  readonly label: string;
  readonly description?: string;
  /** When set, the label renders as a real `<label htmlFor>` bound to the control (e.g. a `Toggle`'s `id`). */
  readonly htmlFor?: string;
  readonly control: ReactNode;
}

export function SettingRow({ label, description, htmlFor, control }: SettingRowProps) {
  return (
    <div className="flex min-h-touch items-center gap-3 border-b border-line py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        {htmlFor !== undefined ? (
          <label htmlFor={htmlFor} className="block text-base text-fg">
            {label}
          </label>
        ) : (
          <p className="text-base text-fg">{label}</p>
        )}
        {description !== undefined && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
      </div>
      <div className="flex-none">{control}</div>
    </div>
  );
}
