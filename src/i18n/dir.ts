// `dir` is PER-BLOCK, not per-document.
//
// The interface language (UI locale) decides the document's overall reading
// direction — `applyDocumentDir` sets `<html dir>`/`<html lang>` from it, and
// ONLY from it. The question-translation language is independent and can
// disagree: an English-interface (ltr) page routinely contains an Arabic
// (rtl) translation panel. That panel must flip internally without dragging
// the rest of the page into rtl — hence `<TranslationBlock>`, a scoped
// `dir`/`lang` wrapper used ONLY around translated content, never at the
// document root.

import type { UiLocale, TranslationLocale, TranslationSetting } from '@/types';
import { LOCALE_INFO, type Direction } from './locales';

export function dirFor(locale: UiLocale | TranslationLocale): Direction {
  return LOCALE_INFO[locale].dir;
}

/**
 * Sets `<html lang>` and `<html dir>` from the UI locale only. Call this on
 * startup and whenever the UI locale setting changes. Never call this for
 * the translation locale — that's what `<TranslationBlock>` is for.
 */
export function applyDocumentDir(uiLocale: UiLocale): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.lang = LOCALE_INFO[uiLocale].bcp47;
  root.dir = dirFor(uiLocale);
}

/** Font stack class for a script, used by `<TranslationBlock>`. */
export function fontClassFor(locale: UiLocale | TranslationLocale): string {
  if (locale === 'ar') return 'font-arabic';
  if (locale === 'hi') return 'font-devanagari';
  return 'font-sans';
}

/** Narrows a `TranslationSetting` (`'off' | TranslationLocale`) down to an active locale, or null when translations are off. */
export function activeTranslationLocale(setting: TranslationSetting): TranslationLocale | null {
  return setting === 'off' ? null : setting;
}
