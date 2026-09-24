// Shared Bundesland picker. Used by BOTH the first-run wizard (step 1) and
// Settings, so it lives here rather than inside either route.
//
// Deliberate choices:
//  - No default selection. `value` may be `null`, and nothing is pre-highlighted
//    in that case. Guessing a state would silently teach the wrong 10 questions.
//  - State names stay in German. They are official proper nouns (and what the
//    user will see on every official form), so they are not translated into the
//    interface language — the same reasoning behind showing language endonyms.
//  - NO coat-of-arms images. `states.ts` has a `wappen` field, but it points at
//    the exam's *composite* illustration for that state's "which coat of arms
//    belongs to …" question — a 4-up grid of four different states' arms. Using
//    it here would show four wrong emblems per tile. There is no single-emblem
//    asset in the dataset, so the tile shows the ISO code instead. See the
//    README's known-gaps note.
//  - Logical CSS properties only, so the grid mirrors under `dir="rtl"`.

import { useMemo, useState } from 'react';
import { STATES, type StateCode } from '@/data/states';
import { useT } from '@/i18n/useT';

export interface StatePickerProps {
  readonly value: StateCode | null;
  readonly onChange: (state: StateCode) => void;
  /** Shows a filter box. Worth it in Settings; the wizard shows all 16 at once. */
  readonly searchable?: boolean;
  readonly className?: string;
}

/** Diacritic-insensitive contains, so typing "wurttemberg" finds Baden-Württemberg. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

export function StatePicker({ value, onChange, searchable = false, className }: StatePickerProps) {
  const { t } = useT();
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const needle = fold(query.trim());
    if (needle === '') return STATES;
    return STATES.filter((s) => fold(s.name).includes(needle) || fold(s.code).includes(needle));
  }, [query]);

  return (
    <div className={className}>
      {searchable && (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('state.search')}
          aria-label={t('state.search')}
          className="mb-3 w-full rounded-xl border border-line bg-surface-raised px-3 py-2 text-fg placeholder:text-fg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
      )}

      {/* A radiogroup, not a listbox: exactly one state is active at a time and
          that is what assistive tech should announce. */}
      <ul role="radiogroup" aria-label={t('state.label')} className="grid grid-cols-2 gap-2">
        {visible.map((state) => {
          const selected = state.code === value;
          return (
            <li key={state.code}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChange(state.code)}
                className={[
                  'flex min-h-touch w-full items-center gap-2 rounded-xl border p-2 text-start transition-colors',
                  selected
                    ? 'border-accent bg-accent-soft ring-2 ring-accent'
                    : 'border-line bg-surface-raised hover:border-accent/50',
                ].join(' ')}
              >
                <span
                  aria-hidden="true"
                  className={[
                    'flex h-9 w-9 flex-none items-center justify-center rounded-lg text-xs font-bold tracking-wide',
                    selected ? 'bg-accent text-accent-fg' : 'bg-surface text-fg-muted',
                  ].join(' ')}
                >
                  {state.code}
                </span>
                <span className="min-w-0 text-fg">
                  <span className="block truncate text-sm font-medium">{state.name}</span>
                  {state.isCityState && <span className="block text-xs text-fg-muted">{t('state.cityState')}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {visible.length === 0 && <p className="py-4 text-center text-sm text-fg-muted">{t('common.none')}</p>}
    </div>
  );
}
