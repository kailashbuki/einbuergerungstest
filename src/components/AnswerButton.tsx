import type { ReactNode } from 'react';
import { TranslationBlock } from '@/components/ui/TranslationBlock';
import { useT } from '@/i18n/useT';
import type { OptionKey, TranslationLocale } from '@/types';

/**
 * How an answer currently reads to the user.
 *
 * - `idle`        — not yet answered, tappable.
 * - `selected`    — what the user chose, before grading is shown (mock exam).
 * - `correct`     — after answering: this is the right option.
 * - `wrong`       — after answering: this is what the user picked, and it is wrong.
 * - `eliminated`  — struck out by hint step 2/3; still in the DOM (screen readers
 *                   must be able to hear that it was removed) but not tappable.
 * - `muted`       — after answering: a neither-chosen-nor-correct option.
 */
export type AnswerVisual = 'idle' | 'selected' | 'correct' | 'wrong' | 'eliminated' | 'muted';

export interface AnswerButtonProps {
  readonly optionKey: OptionKey;
  /** The German option text, or the bare panel number for picture questions. */
  readonly text: string;
  /** Translated option text, or `null` when translations are off / it is a panel number. */
  readonly translated: string | null;
  readonly translationLocale: TranslationLocale | null;
  readonly visual: AnswerVisual;
  readonly disabled: boolean;
  readonly onSelect: (key: OptionKey) => void;
}

const VISUAL_CLASSES: Record<AnswerVisual, string> = {
  idle: 'border-line bg-surface-raised text-fg active:bg-surface',
  selected: 'border-accent bg-surface-raised text-fg ring-2 ring-accent',
  correct: 'border-correct bg-correct/15 text-fg',
  wrong: 'border-wrong bg-wrong/15 text-fg',
  eliminated: 'border-line bg-surface text-fg-muted line-through opacity-60',
  muted: 'border-line bg-surface text-fg-muted',
};

const BADGE_CLASSES: Record<AnswerVisual, string> = {
  idle: 'border-line text-fg-muted',
  selected: 'border-accent bg-accent text-accent-fg',
  correct: 'border-correct bg-correct text-accent-fg',
  wrong: 'border-wrong bg-wrong text-accent-fg',
  eliminated: 'border-line text-fg-muted',
  muted: 'border-line text-fg-muted',
};

/**
 * One of the four answers. Full-width and at least 56px tall so it is a
 * comfortable thumb target at 375px, with the a/b/c/d badge on the leading side
 * (logical, so it moves to the right under `dir="rtl"`).
 *
 * The German text is always rendered. A translation, when active, is rendered
 * *underneath* inside its own `TranslationBlock` so an Arabic translation flips
 * only itself and not the button — let alone the page.
 */
export function AnswerButton({
  optionKey,
  text,
  translated,
  translationLocale,
  visual,
  disabled,
  onSelect,
}: AnswerButtonProps): ReactNode {
  const { t } = useT();
  const letter = optionKey.toUpperCase();
  const label = t('q.optionLabel', { letter });

  const statusLabel =
    visual === 'correct'
      ? t('a11y.correctAnswer')
      : visual === 'wrong'
        ? t('a11y.wrongAnswer')
        : visual === 'selected'
          ? t('a11y.selected')
          : null;

  const classes = [
    'flex w-full min-h-touch items-center gap-3 rounded-2xl border px-3 py-3 text-start',
    'text-base leading-snug transition-colors disabled:pointer-events-none',
    VISUAL_CLASSES[visual],
  ].join(' ');

  return (
    <button
      type="button"
      className={classes}
      disabled={disabled}
      onClick={() => onSelect(optionKey)}
      data-option={optionKey}
      data-visual={visual}
    >
      <span
        aria-hidden="true"
        className={[
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold',
          BADGE_CLASSES[visual],
        ].join(' ')}
      >
        {letter}
      </span>
      <span className="sr-only">{label}</span>
      <span className="min-w-0 flex-1">
        <span className="block">{text}</span>
        {translated !== null && translationLocale !== null ? (
          <TranslationBlock locale={translationLocale} className="mt-1 block text-sm text-fg-muted">
            {translated}
          </TranslationBlock>
        ) : null}
      </span>
      {statusLabel !== null ? <span className="sr-only">{statusLabel}</span> : null}
    </button>
  );
}
