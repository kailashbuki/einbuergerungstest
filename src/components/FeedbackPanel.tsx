import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { TranslationBlock } from '@/components/ui/TranslationBlock';
import { useT } from '@/i18n/useT';
import { seedFromQuestionId } from '@/store/session';
import type { Question, TranslationLocale } from '@/types';

/** How many `fb.correct.N` variants exist in the message tables. */
const PRAISE_VARIANTS = 5;

export interface FeedbackPanelProps {
  readonly question: Question;
  readonly correct: boolean;
  /** Streak so far in this session; `0` hides the badge. */
  readonly streak: number;
  /** Translated explanation, or `null`. */
  readonly translatedExplanation: string | null;
  readonly translationLocale: TranslationLocale | null;
  /** `'offer'` shows the requeue button, `'done'` confirms it, `'unavailable'` hides it. */
  readonly requeueState: 'unavailable' | 'offer' | 'done';
  readonly onRequeue: () => void;
}

/**
 * Post-answer feedback.
 *
 * Wrapped in `aria-live="polite"`: the verdict appears without stealing focus,
 * which matters because focus stays on the answer the user just pressed and the
 * next control they want is the Next button below.
 *
 * Praise is varied so five correct answers in a row do not read like a machine,
 * but the variant is chosen from the question id rather than at random — a
 * re-render must not reshuffle the wording under the user's eyes.
 */
export function FeedbackPanel({
  question,
  correct,
  streak,
  translatedExplanation,
  translationLocale,
  requeueState,
  onRequeue,
}: FeedbackPanelProps): ReactNode {
  const { t } = useT();
  const [showExplanation, setShowExplanation] = useState(false);

  const praiseIndex = (seedFromQuestionId(question.id) % PRAISE_VARIANTS) + 1;
  const verdict = correct ? t(`fb.correct.${praiseIndex}`) : t('fb.wrong');
  const hasExplanation = question.explanation.trim().length > 0;

  return (
    <section
      aria-live="polite"
      className={[
        'rounded-2xl border p-3',
        correct ? 'border-correct bg-correct/10' : 'border-wrong bg-wrong/10',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-base font-semibold text-fg">{verdict}</p>
        {correct && streak > 1 ? (
          <p className="rounded-full border border-line px-3 py-1 text-xs text-fg-muted">
            {t('fb.streak', { count: streak })}
          </p>
        ) : null}
      </div>

      {!correct ? (
        <p className="mt-1 text-sm text-fg">
          {t('fb.wrong.correctIs', { letter: question.solution.toUpperCase() })}
        </p>
      ) : null}

      {hasExplanation ? (
        <div className="mt-2">
          <Button
            variant="ghost"
            onClick={() => setShowExplanation((open) => !open)}
            aria-expanded={showExplanation}
            className="px-3 py-2 text-sm"
          >
            {showExplanation ? t('fb.hideExplanation') : t('fb.showExplanation')}
          </Button>
          {showExplanation ? (
            <div className="mt-2 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{t('fb.why')}</p>
              {/* German first and always — the exam is German-only. */}
              <p className="text-sm leading-relaxed text-fg">{question.explanation}</p>
              {translatedExplanation !== null && translationLocale !== null ? (
                <TranslationBlock
                  locale={translationLocale}
                  className="border-t border-line pt-2 text-sm leading-relaxed text-fg-muted"
                >
                  {translatedExplanation}
                </TranslationBlock>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {requeueState === 'offer' ? (
        <Button variant="secondary" onClick={onRequeue} className="mt-2 w-full px-4 py-2 text-sm">
          {t('fb.requeue')}
        </Button>
      ) : null}
      {requeueState === 'done' ? (
        <p className="mt-2 text-sm text-fg-muted">{t('fb.requeued')}</p>
      ) : null}
    </section>
  );
}
