import { describe, expect, it, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { dirFor, applyDocumentDir } from './dir';
import { EN_MESSAGES } from './index';
import { I18nContext, useT, type I18nContextValue } from './useT';
import { TranslationBlock } from '@/components/ui/TranslationBlock';

afterEach(() => {
  cleanup();
});

function Probe({ onValue }: { onValue: (t: ReturnType<typeof useT>) => void }) {
  onValue(useT());
  return null;
}

function contextValue(overrides: Partial<I18nContextValue>): I18nContextValue {
  return { uiLocale: 'en', setUiLocale: () => {}, messages: EN_MESSAGES, ready: true, ...overrides };
}

describe('dirFor', () => {
  it('returns rtl for Arabic', () => {
    expect(dirFor('ar')).toBe('rtl');
  });

  it('returns ltr for English', () => {
    expect(dirFor('en')).toBe('ltr');
  });
});

describe('per-block direction (the trap: dir is per-block, not per-document)', () => {
  it('keeps the document dir ltr for an English UI while an embedded Arabic TranslationBlock carries dir="rtl" lang="ar"', () => {
    // The UI locale is English -> the document itself must stay ltr.
    applyDocumentDir('en');

    render(
      createElement(TranslationBlock, { locale: 'ar', children: createElement('span', null, 'مرحبا بالعالم') }),
    );

    // Document root reflects the UI locale only.
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang.toLowerCase().startsWith('en')).toBe(true);

    // The translation panel itself is scoped rtl/ar, independent of the document.
    const block = screen.getByText('مرحبا بالعالم').closest('[data-translation-locale]');
    expect(block).not.toBeNull();
    expect(block?.getAttribute('dir')).toBe('rtl');
    expect(block?.getAttribute('lang')).toBe('ar');
  });
});

describe('useT interpolation', () => {
  it('interpolates {count} and formats numbers via Intl.NumberFormat', () => {
    let captured = '';
    render(
      createElement(
        I18nContext.Provider,
        { value: contextValue({}) },
        createElement(Probe, { onValue: ({ t }) => (captured = t('dash.nemesis.drillThese', { count: 1234 })) }),
      ),
    );
    expect(captured).toBe(EN_MESSAGES['dash.nemesis.drillThese']?.replace('{count}', '1,234'));
    expect(captured).toContain('1,234');
  });
});

describe('missing-key fallback', () => {
  it('falls back to the English string rather than the raw key when the active locale is missing a key', () => {
    let captured = '';
    render(
      createElement(
        I18nContext.Provider,
        { value: contextValue({ uiLocale: 'tr', messages: {} }) },
        createElement(Probe, { onValue: ({ t }) => (captured = t('nav.dashboard')) }),
      ),
    );
    expect(captured).toBe(EN_MESSAGES['nav.dashboard']);
    expect(captured).not.toBe('nav.dashboard');
    expect(captured.trim().length).toBeGreaterThan(0);
  });

  it('never renders a raw dotted key or an empty string when a key is missing everywhere', () => {
    let captured = '';
    render(
      createElement(
        I18nContext.Provider,
        { value: contextValue({ uiLocale: 'tr', messages: {} }) },
        createElement(Probe, { onValue: ({ t }) => (captured = t('totally.nonexistent.key')) }),
      ),
    );
    expect(captured).not.toBe('totally.nonexistent.key');
    expect(captured.trim().length).toBeGreaterThan(0);
  });
});
