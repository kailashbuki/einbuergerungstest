import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { MAX_HINTS, eliminatedOptions } from '@/store/session';
import type { Question } from '@/types';

export interface HintPanelProps {
  readonly question: Question;
  /** Hints already taken for this attempt, 0–{@link MAX_HINTS}. */
  readonly hintsUsed: number;
  /** Total hints this question has ever cost, from persisted progress. */
  readonly lifetimeHints: number;
  readonly disabled: boolean;
  readonly onHint: () => void;
}

/**
 * The three-step hint ladder.
 *
 * Each step costs more than the last and the cost is permanent: the app store
 * accumulates `hintsUsed` for the question's whole lifetime and `masteryOf`
 * refuses ★★★ to any question with a non-zero count. That is why
 * `hint.noMastery` is shown *before* the first hint is taken and not as an
 * apology afterwards — the user has to be able to decline an irreversible trade.
 *
 * Step 2's elimination is derived from the question id (see `eliminatedOptions`),
 * so the same two options disappear every time. Re-rolling for a kinder hint is
 * not a strategy the app offers.
 */
export function HintPanel({
  question,
  hintsUsed,
  lifetimeHints,
  disabled,
  onHint,
}: HintPanelProps): ReactNode {
  const { t } = useT();
  const exhausted = hintsUsed >= MAX_HINTS;
  const struck = eliminatedOptions(question.id, question.solution, hintsUsed);

  return (
    <section
      aria-label={t('hint.button')}
      className="rounded-2xl border border-line bg-surface-raised p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">
          {hintsUsed > 0 ? t('hint.counter', { current: hintsUsed, total: MAX_HINTS }) : t('hint.button')}
        </p>
        <Button
          variant="secondary"
          onClick={onHint}
          disabled={disabled || exhausted}
          className="px-4 py-2 text-sm"
        >
          {exhausted ? t('hint.none') : t('hint.button')}
        </Button>
      </div>

      {/* The warning has to precede the first hint: after the tap the damage is done. */}
      {hintsUsed === 0 ? (
        <p className="mt-2 text-sm text-fg-muted">{t('hint.noMastery')}</p>
      ) : null}

      {/* aria-live so each newly revealed step is announced without moving focus. */}
      <div aria-live="polite" className="mt-2 space-y-2">
        {hintsUsed >= 1 ? (
          <div>
            <p className="text-sm font-semibold text-fg">{t('hint.1.title')}</p>
            <p className="text-sm text-fg-muted">
              {t('hint.1.category', { category: t(`category.${question.category}`) })}
            </p>
          </div>
        ) : null}

        {hintsUsed >= 2 ? (
          <div>
            <p className="text-sm font-semibold text-fg">{t('hint.2.title')}</p>
            <p className="text-sm text-fg-muted">
              {t('hint.2.done')}{' '}
              <span data-testid="hint-eliminated">
                {struck.map((key) => key.toUpperCase()).join(', ')}
              </span>
            </p>
          </div>
        ) : null}

        {hintsUsed >= MAX_HINTS ? (
          <div>
            <p className="text-sm font-semibold text-fg">{t('hint.3.title')}</p>
            <p className="text-sm text-fg-muted">
              {t('fb.wrong.correctIs', { letter: question.solution.toUpperCase() })}
            </p>
          </div>
        ) : null}
      </div>

      {lifetimeHints > 0 ? (
        <p className="mt-2 text-xs text-fg-muted">{t('hint.used', { count: lifetimeHints })}</p>
      ) : null}
    </section>
  );
}
