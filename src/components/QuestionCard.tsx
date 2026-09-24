import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnswerButton, type AnswerVisual } from '@/components/AnswerButton';
import { FeedbackPanel } from '@/components/FeedbackPanel';
import { FlagButton } from '@/components/FlagButton';
import { HintPanel } from '@/components/HintPanel';
import { NoteEditor } from '@/components/NoteEditor';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { TranslationBlock } from '@/components/ui/TranslationBlock';
import { asset } from '@/config/paths';
import { activeTranslationLocale } from '@/i18n/dir';
import { loadQuestionTranslations } from '@/i18n/index';
import { LOCALE_INFO } from '@/i18n/locales';
import { useT } from '@/i18n/useT';
import { cancelSpeech, isTtsAvailable, speakGerman } from '@/lib/tts';
import { useQuestionProgress, useSettings } from '@/store';
import { MAX_HINTS, eliminatedOptions } from '@/store/session';
import {
  OPTION_KEYS,
  type OptionKey,
  type Question,
  type QuestionTranslation,
  type QuestionTranslations,
  type TranslationLocale,
} from '@/types';

/* ───────────────────────────── translations ─────────────────────────────── */

/**
 * Synchronous mirror of `loadQuestionTranslations`'s own cache. The async loader
 * is memoised, but it still resolves on a microtask, which would flash an
 * untranslated question on every single card. Remembering the resolved table
 * here lets the *next* question render translated on its first paint.
 */
const TRANSLATION_SNAPSHOT = new Map<TranslationLocale, QuestionTranslations>();

export interface ActiveTranslations {
  readonly locale: TranslationLocale | null;
  readonly translations: QuestionTranslations | null;
}

/**
 * The active question-translation table, lazily loaded.
 *
 * Reads `settings.translation` — which is completely independent of
 * `settings.uiLocale`. An English interface showing an Arabic translation is a
 * normal, supported combination, so nothing here may touch `<html dir>`; the
 * flip is done per block by `<TranslationBlock>`.
 */
export function useQuestionTranslations(): ActiveTranslations {
  const { translation } = useSettings();
  const locale = activeTranslationLocale(translation);
  const [translations, setTranslations] = useState<QuestionTranslations | null>(() =>
    locale === null ? null : (TRANSLATION_SNAPSHOT.get(locale) ?? null),
  );

  useEffect(() => {
    if (locale === null) {
      setTranslations(null);
      return undefined;
    }
    const cached = TRANSLATION_SNAPSHOT.get(locale);
    if (cached !== undefined) {
      setTranslations(cached);
      return undefined;
    }
    let cancelled = false;
    // One locale, once — never all seven.
    void loadQuestionTranslations(locale).then((loaded) => {
      if (loaded !== null) TRANSLATION_SNAPSHOT.set(locale, loaded);
      if (!cancelled) setTranslations(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  return { locale, translations };
}

/* ──────────────────────────── picture questions ─────────────────────────── */

const NUMERIC = /^\d+$/;

/**
 * True for the ~35 questions whose four options are bare panel numbers
 * ("1".."4") pointing at the numbered quadrants of one composite image. Their
 * options are not prose: they must not be translated (there is nothing to
 * translate) and they must read as the panel number they refer to.
 *
 * Numeric options *without* an image (`"Wie viele Bundesländer…"` → 3/4/5/6) are
 * genuine answers and are deliberately excluded.
 */
export function isPanelQuestion(question: Question): boolean {
  if (question.image === undefined) return false;
  return OPTION_KEYS.every((key) => NUMERIC.test(question.options[key].trim()));
}

/* ─────────────────────────────── the card ───────────────────────────────── */

export interface QuestionCardProps {
  readonly question: Question;
  /** Hints taken for this attempt. Ignored when `bare`. */
  readonly hintsUsed?: number;
  readonly onHint?: () => void;
  /** Controlled recall-first reveal. Omit both to let the card manage it itself. */
  readonly optionsRevealed?: boolean;
  readonly onReveal?: () => void;
  readonly chosen?: OptionKey | null;
  readonly answered?: boolean;
  readonly onAnswer?: (key: OptionKey) => void;
  /** Streak so far, for the `fb.streak` badge. */
  readonly streak?: number;
  readonly onNext?: () => void;
  readonly nextLabel?: string;
  readonly onSkip?: () => void;
  readonly requeueState?: 'unavailable' | 'offer' | 'done';
  readonly onRequeue?: () => void;
  /** `q.progress`-style label rendered in the meta row. */
  readonly progressLabel?: string;
  /**
   * Mock-exam mode: no hints, no explanation, no flag, no note, no correctness
   * feedback. The exam gives none of those, so practising under them would
   * inflate the predicted score.
   */
  readonly bare?: boolean;
}

/**
 * The single reusable question unit: learn session, drill, and — with `bare` —
 * the mock exam.
 *
 * Layout is built around the thumb: the question text, image and hints occupy
 * the scrollable upper area, and the four answers are pinned to the bottom of
 * the card with `mt-auto` so they are always reachable one-handed at 375px and
 * never require a stretch to the top of the screen.
 *
 * Recall-first (`settings.recallFirst`) hides the options on first render. That
 * is the pedagogical core: recognising the right answer in a list is far easier
 * than recalling it, and only the second skill transfers to the exam. The
 * options are not merely visually hidden — they are absent from the DOM, so
 * neither a screen reader nor a curious tab press can leak them.
 */
export function QuestionCard({
  question,
  hintsUsed = 0,
  onHint,
  optionsRevealed,
  onReveal,
  chosen = null,
  answered = false,
  onAnswer,
  streak = 0,
  onNext,
  nextLabel,
  onSkip,
  requeueState = 'unavailable',
  onRequeue,
  progressLabel,
  bare = false,
}: QuestionCardProps): ReactNode {
  const { t } = useT();
  const settings = useSettings();
  const { locale, translations } = useQuestionTranslations();
  const progress = useQuestionProgress(question.id);

  /* ── recall-first reveal: controlled by the session, self-managed otherwise ── */
  const [revealedFor, setRevealedFor] = useState<string | null>(null);
  const selfRevealed = !settings.recallFirst || revealedFor === question.id;
  const revealed = optionsRevealed ?? selfRevealed;
  const reveal = useCallback(() => {
    if (onReveal !== undefined) onReveal();
    else setRevealedFor(question.id);
  }, [onReveal, question.id]);
  const hide = useCallback(() => {
    // Only meaningful in the uncontrolled case; the session never un-reveals.
    setRevealedFor(null);
  }, []);

  /* ───────────────────────────── translation ─────────────────────────────── */
  const translation: QuestionTranslation | undefined =
    translations === null ? undefined : translations[question.id];
  const [translationOpenFor, setTranslationOpenFor] = useState<string | null>(null);
  const translationOpen = settings.alwaysShowTranslation || translationOpenFor === question.id;
  const panel = isPanelQuestion(question);

  /* ─────────────────────────────── hints ────────────────────────────────── */
  const hintsEnabled = !bare && onHint !== undefined;
  const struck = useMemo(
    () => (hintsEnabled ? eliminatedOptions(question.id, question.solution, hintsUsed) : []),
    [hintsEnabled, question.id, question.solution, hintsUsed],
  );

  /* ──────────────────────────────── TTS ────────────────────────────────── */
  const germanText = useMemo(() => {
    const parts = [question.question];
    if (revealed && !panel) {
      for (const key of OPTION_KEYS) parts.push(question.options[key]);
    }
    return parts.join('. ');
  }, [question, revealed, panel]);

  const ttsPossible = settings.tts && isTtsAvailable();
  const [speaking, setSpeaking] = useState(false);

  const stopSpeaking = useCallback(() => {
    cancelSpeech();
    setSpeaking(false);
  }, []);

  const startSpeaking = useCallback(
    (text: string) => {
      // `speakGerman` never throws and reports failure synchronously, so an
      // unavailable voice simply leaves the button in its idle state.
      const started = speakGerman(text, { onEnd: () => setSpeaking(false) });
      setSpeaking(started);
    },
    [],
  );

  // Autoplay + stop-on-change. Reading question 4 aloud must never continue over
  // question 5, so this cleanup runs on every question change regardless.
  const autoplay = ttsPossible && settings.ttsAutoplay;
  useEffect(() => {
    if (autoplay) startSpeaking(question.question);
    return () => {
      cancelSpeech();
      setSpeaking(false);
    };
  }, [autoplay, question.question, startSpeaking]);

  /* ───────────────────────── keyboard (desktop) ─────────────────────────── */
  const pick = useCallback(
    (key: OptionKey) => {
      if (answered || onAnswer === undefined) return;
      if (struck.includes(key)) return;
      onAnswer(key);
    },
    [answered, onAnswer, struck],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      // Never hijack typing in the note editor.
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }

      if (event.key === 'Enter') {
        if (answered && onNext !== undefined) {
          event.preventDefault();
          onNext();
        } else if (!answered && !revealed) {
          event.preventDefault();
          reveal();
        }
        return;
      }

      const digit = Number.parseInt(event.key, 10);
      if (!Number.isInteger(digit) || digit < 1 || digit > OPTION_KEYS.length) return;
      const key = OPTION_KEYS[digit - 1];
      if (key === undefined) return;
      if (!revealed) {
        event.preventDefault();
        reveal();
        return;
      }
      event.preventDefault();
      pick(key);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [answered, onNext, revealed, reveal, pick]);

  /* ───────────────────────────── rendering ─────────────────────────────── */

  const visualFor = (key: OptionKey): AnswerVisual => {
    if (answered) {
      if (key === question.solution) return 'correct';
      if (key === chosen) return 'wrong';
      return 'muted';
    }
    if (struck.includes(key)) return 'eliminated';
    if (key === chosen) return 'selected';
    return 'idle';
  };

  const optionText = (key: OptionKey): string => question.options[key];
  const optionTranslation = (key: OptionKey): string | null => {
    if (panel || translation === undefined) return null;
    const value = translation.options[key];
    return value.trim().length > 0 ? value : null;
  };

  return (
    <article className="flex min-h-full flex-col gap-3">
      {/* ── meta row ── */}
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium uppercase tracking-wide text-fg-muted">
            {t('q.number', { number: question.number })}
          </span>
          {progressLabel !== undefined ? (
            <span className="text-xs text-fg-muted">{progressLabel}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {ttsPossible ? (
            <IconButton
              aria-label={speaking ? t('q.stopReading') : t('q.readAloud')}
              aria-pressed={speaking}
              active={speaking}
              onClick={() => (speaking ? stopSpeaking() : startSpeaking(germanText))}
            >
              <SpeakerIcon muted={speaking} />
            </IconButton>
          ) : null}
          {!bare ? <FlagButton questionId={question.id} /> : null}
        </div>
      </header>

      {/* ── scrollable upper area ── */}
      <div className="flex-1 space-y-3">
        {/* The German text is always visible; a translation is an aid alongside it. */}
        <h2 lang="de" className="text-start text-xl font-semibold leading-snug text-fg">
          {question.question}
        </h2>

        {question.image !== undefined ? (
          <img
            src={asset(question.image)}
            alt={t('q.imageAlt', { number: question.number })}
            className="mx-auto max-h-64 w-full rounded-2xl border border-line object-contain"
            loading="lazy"
          />
        ) : null}

        {locale !== null && translation !== undefined ? (
          <div>
            {!settings.alwaysShowTranslation ? (
              <Button
                variant="ghost"
                onClick={() => setTranslationOpenFor(translationOpen ? null : question.id)}
                aria-expanded={translationOpen}
                className="px-3 py-2 text-sm"
              >
                {translationOpen ? t('q.hideTranslation') : t('q.showTranslation')}
              </Button>
            ) : null}
            {translationOpen ? (
              <section
                className="mt-1 rounded-2xl border border-line bg-surface-raised p-3"
                aria-label={t('a11y.translationBlock', { language: LOCALE_INFO[locale].endonym })}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  {t('q.translationLabel')}
                </p>
                <TranslationBlock locale={locale} className="mt-1 text-base leading-relaxed text-fg">
                  {translation.question}
                </TranslationBlock>
              </section>
            ) : null}
          </div>
        ) : null}

        {!revealed ? <p className="text-sm text-fg-muted">{t('q.recallPrompt')}</p> : null}

        {hintsEnabled && onHint !== undefined ? (
          <HintPanel
            question={question}
            hintsUsed={Math.min(hintsUsed, MAX_HINTS)}
            lifetimeHints={progress?.hintsUsed ?? 0}
            disabled={answered}
            onHint={onHint}
          />
        ) : null}

        {answered && !bare ? (
          <FeedbackPanel
            question={question}
            correct={chosen === question.solution}
            streak={streak}
            translatedExplanation={translation?.explanation ?? null}
            translationLocale={locale}
            requeueState={requeueState}
            onRequeue={onRequeue ?? (() => undefined)}
          />
        ) : null}

        {!bare ? <NoteEditor questionId={question.id} /> : null}
      </div>

      {/* ── thumb zone: reveal / answers / next ── */}
      <div className="mt-auto space-y-2 pt-1">
        {!revealed ? (
          <div className="flex gap-2">
            <Button onClick={reveal} className="flex-1">
              {t('q.showOptions')}
            </Button>
            {onSkip !== undefined ? (
              <Button variant="ghost" onClick={onSkip}>
                {t('q.skip')}
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            <ul className="space-y-2">
              {OPTION_KEYS.map((key) => (
                <li key={key}>
                  <AnswerButton
                    optionKey={key}
                    text={optionText(key)}
                    translated={optionTranslation(key)}
                    translationLocale={locale}
                    visual={visualFor(key)}
                    disabled={answered || struck.includes(key) || onAnswer === undefined}
                    onSelect={pick}
                  />
                </li>
              ))}
            </ul>

            {/* `autoFocus` fires on the mount that follows grading: it scrolls the
                button into the thumb zone and makes the Enter shortcut discoverable
                instead of secret. */}
            {answered && onNext !== undefined ? (
              // eslint-disable-next-line jsx-a11y/no-autofocus
              <Button autoFocus onClick={onNext} className="w-full">
                {nextLabel ?? t('q.next')}
              </Button>
            ) : null}

            {!answered && optionsRevealed === undefined && settings.recallFirst ? (
              <Button variant="ghost" onClick={hide} className="w-full text-sm">
                {t('q.hideOptions')}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </article>
  );
}

function SpeakerIcon({ muted }: { readonly muted: boolean }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 9v6h3l5 4V5L7 9H4Z" />
      {muted ? <path d="M16 9l4 6M20 9l-4 6" /> : <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" />}
    </svg>
  );
}
