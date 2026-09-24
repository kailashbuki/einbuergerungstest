// Post-exam review: the one screen where a mock exam actually teaches
// something. Unlike `MockExam.tsx`, explanations and translations are always
// available here — `mockTranslations`/"German only" is a rule about the exam
// simulation, not about learning from it afterwards, which is why this file
// ignores that setting entirely and only respects the user's translation
// *language* choice (`settings.translation`).

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useT } from '@/i18n/useT';
import { asset } from '@/config/paths';
import { activeTranslationLocale } from '@/i18n/dir';
import { loadQuestionTranslations, LOCALE_INFO } from '@/i18n/index';
import { TranslationBlock } from '@/components/ui/TranslationBlock';
import { Button } from '@/components/ui/Button';
import { useMocks, useSettings } from '@/store';
import { questionById } from '@/lib/deck';
import { MOCK_PASS_MARK } from '@/lib/mockExam';
import type { AnswerRecord, MockResult, OptionKey, Question, QuestionTranslations } from '@/types';

type Filter = 'all' | 'wrong' | 'skipped';

const FILTERS: readonly { readonly key: Filter; readonly labelKey: string }[] = [
  { key: 'all', labelKey: 'mock.filter.all' },
  { key: 'wrong', labelKey: 'mock.filter.wrong' },
  { key: 'skipped', labelKey: 'mock.filter.skipped' },
];

function matchesFilter(answer: AnswerRecord, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'skipped') return answer.chosen === null;
  return answer.chosen !== null && !answer.correct;
}

/** `mock.duration` wants a rendered string, not a raw ms value; composes the two `time.*` keys the table already has rather than inventing a new one. */
function formatDuration(ms: number, t: (key: string, params?: Readonly<Record<string, string | number>>) => string): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return t('time.seconds', { count: seconds });
  return `${t('time.minutes', { count: minutes })} ${t('time.seconds', { count: seconds })}`;
}

interface AnswerRowProps {
  readonly answer: AnswerRecord;
  readonly question: Question;
  readonly translationLocale: ReturnType<typeof activeTranslationLocale>;
  readonly translations: QuestionTranslations | null;
}

function AnswerRow({ answer, question, translationLocale, translations }: AnswerRowProps) {
  const { t } = useT();
  const translation = translationLocale !== null ? translations?.[question.id] : undefined;

  const chosenLabel = (key: OptionKey | null): string => {
    if (key === null) return t('mock.noAnswer');
    return question.options[key];
  };

  return (
    <li className="rounded-xl border border-line bg-surface-raised p-4">
      <p className="font-medium text-fg">{question.question}</p>

      {question.image !== undefined && (
        <img
          src={asset(question.image)}
          alt={t('q.imageAlt', { number: question.number })}
          className="mt-2 max-w-full rounded-lg border border-line"
        />
      )}

      {translationLocale !== null && translation !== undefined && (
        <TranslationBlock locale={translationLocale} className="mt-2 rounded-lg bg-surface p-3 text-sm">
          <span className="sr-only">{t('a11y.translationBlock', { language: LOCALE_INFO[translationLocale].endonym })}</span>
          <p>{translation.question}</p>
        </TranslationBlock>
      )}

      <dl className="mt-3 space-y-1 text-sm">
        <div className="flex flex-wrap items-baseline gap-1">
          <dt className="text-fg-muted">{t('mock.yourAnswer')}:</dt>
          <dd className={answer.correct ? 'text-correct' : 'text-wrong'}>{chosenLabel(answer.chosen)}</dd>
        </div>
        {!answer.correct && (
          <div className="flex flex-wrap items-baseline gap-1">
            <dt className="text-fg-muted">{t('mock.correctAnswer')}:</dt>
            <dd className="text-correct">{question.options[question.solution]}</dd>
          </div>
        )}
      </dl>

      {question.explanation.length > 0 && (
        <p className="mt-2 text-sm text-fg-muted">{question.explanation}</p>
      )}

      {translationLocale !== null && translation !== undefined && translation.explanation.length > 0 && (
        <TranslationBlock locale={translationLocale} className="mt-1 text-sm text-fg-muted">
          {translation.explanation}
        </TranslationBlock>
      )}
    </li>
  );
}

function findResult(mocks: readonly MockResult[], mockId: string | undefined): MockResult | undefined {
  if (mockId === undefined) return undefined;
  return mocks.find((m) => m.id === mockId);
}

export default function Review() {
  const { mockId } = useParams<{ mockId: string }>();
  const { t } = useT();
  const mocks = useMocks();
  const settings = useSettings();

  const result = findResult(mocks, mockId);
  const [filter, setFilter] = useState<Filter>('all');
  const [translations, setTranslations] = useState<QuestionTranslations | null>(null);

  // Review is not gated by `mockTranslations` — that setting only governs the
  // exam simulation itself. Here only the user's chosen translation language matters.
  const translationLocale = activeTranslationLocale(settings.translation);

  useEffect(() => {
    if (translationLocale === null) {
      setTranslations(null);
      return;
    }
    let cancelled = false;
    void loadQuestionTranslations(translationLocale).then((loaded) => {
      if (!cancelled) setTranslations(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [translationLocale]);

  const filteredAnswers = useMemo(() => {
    if (result === undefined) return [];
    return result.answers.filter((a) => matchesFilter(a, filter));
  }, [result, filter]);

  // A shared or stale `/review/:mockId` link (or one from a device whose data never
  // synced here) must degrade gracefully, not throw on `undefined`.
  if (result === undefined) {
    return (
      <div className="mx-auto max-w-md p-4 text-center">
        <h1 className="text-2xl font-semibold text-fg">{t('err.notFound.title')}</h1>
        <p className="mt-2 text-fg-muted">{t('err.notFound.desc')}</p>
        <Link to="/" className="mt-4 inline-block">
          <Button variant="primary">{t('err.notFound.home')}</Button>
        </Link>
      </div>
    );
  }

  const neededMore = Math.max(0, MOCK_PASS_MARK - result.correct);

  return (
    <div className="mx-auto max-w-md p-4">
      <h1 className="text-2xl font-semibold text-fg">{t('mock.review.title')}</h1>

      <div className="mt-3 rounded-xl border border-line bg-surface-raised p-4">
        <p className={['text-lg font-semibold', result.passed ? 'text-correct' : 'text-wrong'].join(' ')}>
          {result.passed ? t('mock.passed') : t('mock.failed')}
        </p>
        <p className="mt-1 text-fg">{t('mock.result', { correct: result.correct, total: result.total })}</p>
        {!result.passed && <p className="text-sm text-fg-muted">{t('mock.needed', { count: neededMore })}</p>}
        <p className="mt-1 text-sm text-fg-muted">{t('mock.duration', { duration: formatDuration(result.durationMs, t) })}</p>
      </div>

      {translationLocale !== null && (
        <p className="mt-3 text-sm text-fg-muted">{t('mock.translationsUnlocked')}</p>
      )}

      <div className="mt-4 flex gap-2" role="group" aria-label={t('mock.review.title')}>
        {FILTERS.map(({ key, labelKey }) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
            className={[
              'min-h-touch min-w-touch rounded-full border px-4 text-sm font-medium transition-colors',
              filter === key ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface-raised text-fg',
            ].join(' ')}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      <ul className="mt-4 space-y-3">
        {filteredAnswers.map((answer) => {
          const question = questionById(answer.questionId);
          if (question === undefined) return null;
          return (
            <AnswerRow
              key={answer.questionId}
              answer={answer}
              question={question}
              translationLocale={translationLocale}
              translations={translations}
            />
          );
        })}
      </ul>
    </div>
  );
}
