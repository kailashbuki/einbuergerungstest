// A real switch control: `role="switch"` + `aria-checked`, never a checkbox
// styled to look like one and never a `div onClick`. The visible pill is
// smaller than the tap target — the button itself is `min-h-touch`/`min-w-touch`
// (44px) so thumbs never miss, per the mobile tap-target rules for this screen.
//
// RTL: the thumb's resting side is expressed with flexbox `justify-start` /
// `justify-end`, which flip automatically under `dir="rtl"` as part of the CSS
// flexbox spec (main-axis start/end follow inline direction). No `rtl:`
// override or physical `left`/`right`/`translate-x` is needed.

export interface ToggleProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  /** Accessible name. Also works standalone (outside a `<label>`), so callers never get a nameless switch. */
  readonly label: string;
  readonly id?: string;
  readonly disabled?: boolean;
}

export function Toggle({ checked, onChange, label, id, disabled = false }: ToggleProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex min-h-touch min-w-touch flex-none items-center justify-center rounded-full disabled:opacity-50 disabled:pointer-events-none"
    >
      <span
        aria-hidden="true"
        className={[
          'flex h-7 w-[3.25rem] flex-none items-center rounded-full border p-0.5 transition-colors',
          checked ? 'justify-end border-accent bg-accent' : 'justify-start border-line bg-surface-raised',
        ].join(' ')}
      >
        <span className="h-5 w-5 flex-none rounded-full bg-white shadow" />
      </span>
    </button>
  );
}
