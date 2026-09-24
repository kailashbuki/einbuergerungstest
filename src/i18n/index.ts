// Locale resolution + lazy loading.
//
// English (`ui.en.json`) is imported eagerly below — it is both a real UI
// locale and the universal fallback, so it must always be in memory. The
// other 7 UI locale files, and all 7 question-translation files, are loaded
// via dynamic `import()` through the static maps below. Vite can only
// code-split dynamic imports it can statically analyse, so these are plain
// object literals of arrow functions — NOT a templated `import('./ui.' + x)`.

import type { UiLocale, TranslationLocale, QuestionTranslations } from '@/types';
import { isUiLocale, isTranslationLocale } from './locales';
import enMessagesJson from './ui.en.json';

export type Messages = Record<string, string>;

/** The English table is the fallback source of truth — every other locale is validated against its key set (see scripts/lint-i18n.ts). */
export const EN_MESSAGES: Messages = enMessagesJson as unknown as Messages;

const uiLoaders: Record<UiLocale, () => Promise<Messages>> = {
  de: () => import('./ui.de.json').then((m) => m.default as unknown as Messages),
  en: () => Promise.resolve(EN_MESSAGES),
  tr: () => import('./ui.tr.json').then((m) => m.default as unknown as Messages),
  ru: () => import('./ui.ru.json').then((m) => m.default as unknown as Messages),
  fr: () => import('./ui.fr.json').then((m) => m.default as unknown as Messages),
  ar: () => import('./ui.ar.json').then((m) => m.default as unknown as Messages),
  uk: () => import('./ui.uk.json').then((m) => m.default as unknown as Messages),
  hi: () => import('./ui.hi.json').then((m) => m.default as unknown as Messages),
};

const translationLoaders: Record<TranslationLocale, () => Promise<QuestionTranslations>> = {
  en: () => import('@/data/i18n/questions.en.json').then((m) => m.default as unknown as QuestionTranslations),
  tr: () => import('@/data/i18n/questions.tr.json').then((m) => m.default as unknown as QuestionTranslations),
  ru: () => import('@/data/i18n/questions.ru.json').then((m) => m.default as unknown as QuestionTranslations),
  fr: () => import('@/data/i18n/questions.fr.json').then((m) => m.default as unknown as QuestionTranslations),
  ar: () => import('@/data/i18n/questions.ar.json').then((m) => m.default as unknown as QuestionTranslations),
  uk: () => import('@/data/i18n/questions.uk.json').then((m) => m.default as unknown as QuestionTranslations),
  hi: () => import('@/data/i18n/questions.hi.json').then((m) => m.default as unknown as QuestionTranslations),
};

const uiCache = new Map<UiLocale, Messages>([['en', EN_MESSAGES]]);
const translationCache = new Map<TranslationLocale, QuestionTranslations>();

/** Loads (and memoises) the UI message table for a locale. Never throws — falls back to English on load failure. */
export async function loadUiMessages(locale: UiLocale): Promise<Messages> {
  const cached = uiCache.get(locale);
  if (cached) return cached;
  try {
    const messages = await uiLoaders[locale]();
    uiCache.set(locale, messages);
    return messages;
  } catch (err) {
    console.error(`[i18n] failed to load UI messages for "${locale}", falling back to English`, err);
    return EN_MESSAGES;
  }
}

/** Loads (and memoises) the question-translation table for a locale. Never throws — returns null on failure so callers can fall back to German. */
export async function loadQuestionTranslations(locale: TranslationLocale): Promise<QuestionTranslations | null> {
  const cached = translationCache.get(locale);
  if (cached) return cached;
  try {
    const translations = await translationLoaders[locale]();
    translationCache.set(locale, translations);
    return translations;
  } catch (err) {
    console.error(`[i18n] failed to load question translations for "${locale}"`, err);
    return null;
  }
}

/** Best-effort UI locale from the browser, falling back to German (the app's native language). Never throws. */
export function detectUiLocale(): UiLocale {
  const languages = safeNavigatorLanguages();
  for (const tag of languages) {
    const primary = tag.split('-')[0]?.toLowerCase() ?? '';
    if (isUiLocale(primary)) return primary;
  }
  return 'de';
}

/** Best-effort translation locale from the browser. Returns `'off'` when none of the user's languages has a translation, which also covers German (never a translation target). */
export function detectTranslationLocale(): TranslationLocale | 'off' {
  const languages = safeNavigatorLanguages();
  for (const tag of languages) {
    const primary = tag.split('-')[0]?.toLowerCase() ?? '';
    if (isTranslationLocale(primary)) return primary;
  }
  return 'off';
}

function safeNavigatorLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) return navigator.languages;
  if (typeof navigator.language === 'string' && navigator.language.length > 0) return [navigator.language];
  return [];
}

export * from './locales';
export * from './dir';
