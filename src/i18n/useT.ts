import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { UiLocale } from '@/types';
import { EN_MESSAGES, loadUiMessages, type Messages } from './index';
import { LOCALE_INFO } from './locales';
import { applyDocumentDir } from './dir';

export type TParams = Readonly<Record<string, string | number>>;

const warnedMissingKeys = new Set<string>();

/** Interpolates `{placeholder}` tokens. Numbers are formatted with `Intl.NumberFormat` for `bcp47`. */
function interpolate(template: string, bcp47: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!(name in params)) return match;
    const value = params[name];
    if (value === undefined) return match;
    return typeof value === 'number' ? new Intl.NumberFormat(bcp47).format(value) : value;
  });
}

/** Turns `"dash.readiness.title"` into a readable last-resort label if a key is missing from every table, including English. This should never happen in practice — English is the source of truth — but it must never render a bare dotted key or an empty string. */
function humanizeKey(key: string): string {
  const last = key.split('.').pop() ?? key;
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function resolveMessage(key: string, messages: Messages, bcp47: string): string {
  const own = messages[key];
  if (own !== undefined && own.trim() !== '') return own;
  const fallback = EN_MESSAGES[key];
  if (fallback !== undefined && fallback.trim() !== '') {
    if (import.meta.env.DEV && !warnedMissingKeys.has(`${bcp47}:${key}`)) {
      warnedMissingKeys.add(`${bcp47}:${key}`);
      console.warn(`[i18n] missing key "${key}" — falling back to English`);
    }
    return fallback;
  }
  if (import.meta.env.DEV && !warnedMissingKeys.has(`missing-everywhere:${key}`)) {
    warnedMissingKeys.add(`missing-everywhere:${key}`);
    console.warn(`[i18n] key "${key}" is missing from every locale, including English`);
  }
  return humanizeKey(key);
}

export interface I18nContextValue {
  readonly uiLocale: UiLocale;
  readonly setUiLocale: (locale: UiLocale) => void;
  readonly messages: Messages;
  readonly ready: boolean;
}

export const I18nContext = createContext<I18nContextValue | null>(null);

export interface I18nProviderProps {
  readonly initialLocale: UiLocale;
  readonly children: ReactNode;
}

/** Holds the active UI locale + its loaded message table, applies `<html lang|dir>`, and loads new locales on demand when `setUiLocale` is called. */
export function I18nProvider({ initialLocale, children }: I18nProviderProps): ReactNode {
  const [uiLocale, setUiLocaleState] = useState<UiLocale>(initialLocale);
  const [messages, setMessages] = useState<Messages>(EN_MESSAGES);
  const [ready, setReady] = useState<boolean>(initialLocale === 'en');

  useEffect(() => {
    applyDocumentDir(uiLocale);
    let cancelled = false;
    setReady(uiLocale === 'en');
    void loadUiMessages(uiLocale).then((loaded) => {
      if (cancelled) return;
      setMessages(loaded);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [uiLocale]);

  const setUiLocale = useCallback((locale: UiLocale) => setUiLocaleState(locale), []);

  const value = useMemo<I18nContextValue>(
    () => ({ uiLocale, setUiLocale, messages, ready }),
    [uiLocale, setUiLocale, messages, ready],
  );

  return createElement(I18nContext.Provider, { value }, children);
}

export interface UseTResult {
  readonly t: (key: string, params?: TParams) => string;
  readonly uiLocale: UiLocale;
  readonly ready: boolean;
  readonly formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  readonly formatPercent: (fraction: number) => string;
  readonly formatDate: (value: number | Date, options?: Intl.DateTimeFormatOptions) => string;
  readonly formatList: (items: readonly string[], type?: 'conjunction' | 'disjunction') => string;
  readonly firstDayOfWeek: () => 0 | 1;
}

/** Cheap: reads the shared i18n context, everything else is a stable memoised closure. */
export function useT(): UseTResult {
  const ctx = useContext(I18nContext);
  const uiLocale = ctx?.uiLocale ?? 'de';
  const messages = ctx?.messages ?? EN_MESSAGES;
  const ready = ctx?.ready ?? true;
  const bcp47 = LOCALE_INFO[uiLocale].bcp47;

  const t = useCallback(
    (key: string, params?: TParams) => interpolate(resolveMessage(key, messages, bcp47), bcp47, params),
    [messages, bcp47],
  );

  const formatNumber = useCallback(
    (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(bcp47, options).format(value),
    [bcp47],
  );

  const formatPercent = useCallback(
    (fraction: number) => new Intl.NumberFormat(bcp47, { style: 'percent', maximumFractionDigits: 0 }).format(fraction),
    [bcp47],
  );

  const formatDate = useCallback(
    (value: number | Date, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(bcp47, options).format(value),
    [bcp47],
  );

  const formatList = useCallback(
    (items: readonly string[], type: 'conjunction' | 'disjunction' = 'conjunction') =>
      new Intl.ListFormat(bcp47, { style: 'long', type }).format(items),
    [bcp47],
  );

  const firstDayOfWeekFn = useCallback(() => firstDayOfWeek(uiLocale), [uiLocale]);

  return { t, uiLocale, ready, formatNumber, formatPercent, formatDate, formatList, firstDayOfWeek: firstDayOfWeekFn };
}

interface LocaleWithWeekInfo {
  readonly weekInfo?: { readonly firstDay?: number };
}

/** Monday=1..Sunday=7 per the `Intl.Locale` `weekInfo` proposal; returned here as JS `Date#getDay()`-style 0=Sunday/1=Monday for the streak calendar. Falls back to a static table where `weekInfo` isn't supported. */
export function firstDayOfWeek(locale: UiLocale): 0 | 1 {
  const bcp47 = LOCALE_INFO[locale].bcp47;
  try {
    const IntlLocale = (Intl as unknown as { Locale?: new (tag: string) => LocaleWithWeekInfo }).Locale;
    if (IntlLocale) {
      const firstDay = new IntlLocale(bcp47).weekInfo?.firstDay;
      if (typeof firstDay === 'number') return firstDay === 7 ? 0 : 1;
    }
  } catch {
    /* Intl.Locale#weekInfo not supported in this engine — use the fallback below. */
  }
  // en-US traditionally starts the week on Sunday; every other locale we ship starts on Monday.
  return locale === 'en' ? 0 : 1;
}
