import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { TranslationBlock } from '@/components/ui/TranslationBlock';
import { useT } from '@/i18n/useT';
import type { Question, QuestionTranslation, TranslationLocale } from '@/types';

/**
 * The fact a question establishes: its correct option, plus the explanation as
 * supporting detail. Deriving it rather than authoring 310 separate "fact"
 * strings is what makes the reversal drill possible at all.
 */
export function factOf(question: Question): string {
  return question.options[question.solution];
}

export interface FeynmanCardProps {
  readonly question: Question;
  readonly translation: QuestionTranslation | undefined;
  readonly translationLocale: TranslationLocale | null;
  /**
   * Called with the user's own verdict once they have compared their recall to
   * the real question. It is a self-report, not a grade.
   */
  readonly onSelfAssess: (recalled: boolean) => void;
}

/**
 * The Feynman reversal: a retention check, not a graded question.
 *
 * Normal practice runs fact-hunting → "which of these four is right?". This runs
 * the other way: here is the fact, now state the question it answers. Explaining
 * the direction you were never drilled in is what exposes knowledge you only
 * recognise rather than hold.
 *
 * Crucially this component never reports a correctness verdict to the store. The
 * user's self-assessment is not evidence the spaced-repetition scheduler can
 * trust, and fabricating an `answer()` call from it would corrupt both the
 * schedule and the mastery counts. The caller may use `onSelfAssess` to decide
 * what to show next — nothing more.
 */
export function FeynmanCard({
  question,
  translation,
  translationLocale,
  onSelfAssess,
}: FeynmanCardProps): ReactNode {
  const { t } = useT();
  const [revealed, setRevealed] = useState(false);

  const fact = factOf(question);
  const translatedFact = translation?.options[question.solution] ?? null;

  return (
    <section
      aria-label={t('feynman.title')}
      className="flex min-h-full flex-col gap-3 rounded-2xl border border-line bg-surface-raised p-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-fg">{t('feynman.title')}</h2>
        <span className="rounded-full border border-line px-3 py-1 text-xs text-fg-muted">
          {t('mode.reverse')}
        </span>
      </header>

      <div className="flex-1 space-y-3">
        <div className="rounded-2xl border border-accent bg-surface p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
            {t('feynman.fact')}
          </p>
          <p lang="de" className="mt-1 text-start text-lg font-semibold leading-snug text-fg">
            {fact}
          </p>
          {translatedFact !== null && translationLocale !== null ? (
            <TranslationBlock locale={translationLocale} className="mt-1 text-sm text-fg-muted">
              {translatedFact}
            </TranslationBlock>
          ) : null}
          {question.explanation.trim().length > 0 ? (
            <p lang="de" className="mt-2 text-sm leading-relaxed text-fg-muted">
              {question.explanation}
            </p>
          ) : null}
        </div>

        <p className="text-base text-fg">{t('feynman.prompt')}</p>

        {/* aria-live so the revealed question is announced in place. */}
        <div aria-live="polite">
          {revealed ? (
            <div className="rounded-2xl border border-line bg-surface p-3">
              <p lang="de" className="text-start text-base font-medium leading-snug text-fg">
                {question.question}
              </p>
              {translation !== undefined && translationLocale !== null ? (
                <TranslationBlock locale={translationLocale} className="mt-1 text-sm text-fg-muted">
                  {translation.question}
                </TranslationBlock>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* Thumb zone. */}
      <div className="mt-auto space-y-2">
        {!revealed ? (
          <Button onClick={() => setRevealed(true)} className="w-full">
            {t('q.submit')}
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onSelfAssess(false)} className="flex-1">
              {t('common.no')}
            </Button>
            <Button onClick={() => onSelfAssess(true)} className="flex-1">
              {t('common.yes')}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
