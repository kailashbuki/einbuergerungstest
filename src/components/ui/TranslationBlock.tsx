import type { ReactNode } from 'react';
import type { TranslationLocale } from '@/types';
import { dirFor, fontClassFor, LOCALE_INFO } from '@/i18n/index';

export interface TranslationBlockProps {
  readonly locale: TranslationLocale;
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * Scoped `dir`/`lang` wrapper for translated question content. The document
 * direction always follows the UI locale (see `applyDocumentDir`); this
 * component is how a translation in a *different* direction — most commonly
 * Arabic (rtl) inside an otherwise ltr English/German interface — renders
 * correctly without flipping the surrounding page. Logical CSS properties
 * elsewhere in the app make that flip automatic for this subtree.
 */
export function TranslationBlock({ locale, children, className }: TranslationBlockProps): ReactNode {
  const dir = dirFor(locale);
  const lang = LOCALE_INFO[locale].bcp47;
  const fontClass = fontClassFor(locale);
  const classes = ['text-start', fontClass, className].filter(Boolean).join(' ');
  return (
    <div dir={dir} lang={lang} className={classes} data-translation-locale={locale}>
      {children}
    </div>
  );
}
