// Locale metadata for both locale families in the app:
//  - UI locales: the language of buttons, menus and labels (8, includes `de`/`en`).
//  - Translation locales: the language question text/options/explanations are
//    translated into (7 — German is the source language, never a "translation").
//
// Endonyms: every language is named in its OWN script, never translated into
// the currently-active UI language, matching how language pickers behave in
// almost every well-localized app.

import type { UiLocale, TranslationLocale } from '@/types';

export type Direction = 'ltr' | 'rtl';

export interface LocaleInfo {
  readonly code: UiLocale | TranslationLocale;
  /** The language's own name for itself, in its own script. */
  readonly endonym: string;
  readonly dir: Direction;
  /** BCP-47 tag for `Intl.*` APIs. */
  readonly bcp47: string;
}

/** All 8 UI locales, in a stable display order. */
export const UI_LOCALES: readonly UiLocale[] = ['de', 'en', 'tr', 'ru', 'fr', 'ar', 'uk', 'hi'] as const;

/** All 7 translation locales (no `de` — German is the source, not a translation target). */
export const TRANSLATION_LOCALES: readonly TranslationLocale[] = ['en', 'tr', 'ru', 'fr', 'ar', 'uk', 'hi'] as const;

export const LOCALE_INFO: Readonly<Record<UiLocale | TranslationLocale, LocaleInfo>> = {
  de: { code: 'de', endonym: 'Deutsch', dir: 'ltr', bcp47: 'de-DE' },
  en: { code: 'en', endonym: 'English', dir: 'ltr', bcp47: 'en-US' },
  tr: { code: 'tr', endonym: 'Türkçe', dir: 'ltr', bcp47: 'tr-TR' },
  ru: { code: 'ru', endonym: 'Русский', dir: 'ltr', bcp47: 'ru-RU' },
  fr: { code: 'fr', endonym: 'Français', dir: 'ltr', bcp47: 'fr-FR' },
  ar: { code: 'ar', endonym: 'العربية', dir: 'rtl', bcp47: 'ar' },
  uk: { code: 'uk', endonym: 'Українська', dir: 'ltr', bcp47: 'uk-UA' },
  hi: { code: 'hi', endonym: 'हिन्दी', dir: 'ltr', bcp47: 'hi-IN' },
};

export function isUiLocale(value: string): value is UiLocale {
  return (UI_LOCALES as readonly string[]).includes(value);
}

export function isTranslationLocale(value: string): value is TranslationLocale {
  return (TRANSLATION_LOCALES as readonly string[]).includes(value);
}
