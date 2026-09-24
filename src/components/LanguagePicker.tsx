// Shared language picker, used by BOTH the first-run wizard (steps 2 and 3) and
// Settings, so it lives here rather than inside either route.
//
// Two independent settings share this component:
//  - `kind="ui"`     — the interface language (8 locales, includes German).
//  - `kind="translation"` — the language question text is translated into
//    (7 locales, plus an explicit "Off — German only" choice). German is the
//    source language and is therefore never a translation target.
//
// Every language is labelled with its ENDONYM (its own name in its own script),
// never translated into the active interface language. Each option carries its
// own `lang`/`dir`/font class, so the Arabic entry renders right-to-left in
// correct Naskh even while the surrounding page is left-to-right English —
// `dir` is per-block, not per-document.

import { LOCALE_INFO, TRANSLATION_LOCALES, UI_LOCALES } from '@/i18n/locales';
import { dirFor, fontClassFor } from '@/i18n/dir';
import { useT } from '@/i18n/useT';
import type { TranslationLocale, TranslationSetting, UiLocale } from '@/types';

interface CommonProps {
  readonly className?: string;
}

export interface UiLanguagePickerProps extends CommonProps {
  readonly kind: 'ui';
  readonly value: UiLocale;
  readonly onChange: (locale: UiLocale) => void;
}

export interface TranslationLanguagePickerProps extends CommonProps {
  readonly kind: 'translation';
  readonly value: TranslationSetting;
  readonly onChange: (setting: TranslationSetting) => void;
}

export type LanguagePickerProps = UiLanguagePickerProps | TranslationLanguagePickerProps;

function Row({
  selected,
  onSelect,
  label,
  lang,
  dir,
  fontClass,
  hint,
}: {
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly label: string;
  readonly lang?: string;
  readonly dir?: 'ltr' | 'rtl';
  readonly fontClass?: string;
  readonly hint?: string;
}) {
  return (
    <li>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onSelect}
        className={[
          'flex min-h-touch w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-start transition-colors',
          selected ? 'border-accent bg-accent-soft ring-2 ring-accent' : 'border-line bg-surface-raised hover:border-accent/50',
        ].join(' ')}
      >
        <span className="min-w-0">
          {/* The label carries its own lang/dir/font so a right-to-left endonym
              renders correctly inside a left-to-right list. */}
          <span lang={lang} dir={dir} className={['block truncate text-base text-fg', fontClass].filter(Boolean).join(' ')}>
            {label}
          </span>
          {hint !== undefined && <span className="block text-xs text-fg-muted">{hint}</span>}
        </span>
        <span
          aria-hidden="true"
          className={[
            'h-5 w-5 flex-none rounded-full border-2',
            selected ? 'border-accent bg-accent' : 'border-line',
          ].join(' ')}
        />
      </button>
    </li>
  );
}

export function LanguagePicker(props: LanguagePickerProps) {
  const { t } = useT();

  if (props.kind === 'ui') {
    return (
      <ul role="radiogroup" aria-label={t('set.interfaceLanguage')} className={['grid gap-2', props.className].filter(Boolean).join(' ')}>
        {UI_LOCALES.map((locale: UiLocale) => (
          <Row
            key={locale}
            selected={props.value === locale}
            onSelect={() => props.onChange(locale)}
            label={LOCALE_INFO[locale].endonym}
            lang={LOCALE_INFO[locale].bcp47}
            dir={dirFor(locale)}
            fontClass={fontClassFor(locale)}
          />
        ))}
      </ul>
    );
  }

  return (
    <ul role="radiogroup" aria-label={t('set.translationLanguage')} className={['grid gap-2', props.className].filter(Boolean).join(' ')}>
      {/* "Off" comes first and is a real, explicitly-labelled choice rather than
          an empty state, because studying in German only is a legitimate goal. */}
      <Row
        selected={props.value === 'off'}
        onSelect={() => props.onChange('off')}
        label={t('set.translationLanguage.off')}
        hint={t('set.translationLanguage.off.hint')}
      />
      {TRANSLATION_LOCALES.map((locale: TranslationLocale) => (
        <Row
          key={locale}
          selected={props.value === locale}
          onSelect={() => props.onChange(locale)}
          label={LOCALE_INFO[locale].endonym}
          lang={LOCALE_INFO[locale].bcp47}
          dir={dirFor(locale)}
          fontClass={fontClassFor(locale)}
        />
      ))}
    </ul>
  );
}
