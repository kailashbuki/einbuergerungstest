// The mock exam: 33 questions, 60 minutes, real BAMF conditions.
//
// Scheduler decision: answers given here are deliberately NEVER passed to
// `useAppStore().answer()`, i.e. a mock exam never touches `progressModel`'s
// SM-2-lite schedule. A mock is a *measurement* taken under time pressure —
// a rushed guess or a lucky tap here is weaker evidence than a deliberate
// answer in Learn/Drill, and folding 33 of them into the spacing schedule in
// one afternoon would perturb `dueAt`/`ease` for a third of the active deck
// on the strength of a single stressed sitting. The signal is not thrown
// away, though: every `AnswerRecord` (chosen option, correctness, timing) is
// kept in full inside the persisted `MockResult` (see `finishMock` below),
// which is exactly what `Review.tsx` reads. If a future iteration wants mock
// answers to *also* inform scheduling, the right place is a deliberate,
// separate fold over `MockResult.answers` — not silently reusing `answer()`
// here — so the two evidence sources stay distinguishable in the data model.
//
// Distraction suppression: Layout.tsx (not owned by this workstream) always
// renders a header and a bottom nav with tabs to the rest of the app. Rather
// than edit it, the exam phase below renders a `fixed inset-0` full-viewport
// panel at `z-50` — higher than Layout's `z-40` header/nav — so for the
// duration of a timed exam the only reachable UI is the exam itself. This is
// a visual/interaction takeover, not a focus trap; see the report for that
// caveat.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT } from '@/i18n/useT';
import { asset } from '@/config/paths';
import { activeTranslationLocale } from '@/i18n/dir';
import { loadQuestionTranslations, LOCALE_INFO } from '@/i18n/index';
import { TranslationBlock } from '@/components/ui/TranslationBlock';
import { Button } from '@/components/ui/Button';
import { ExamTimer } from '@/components/ExamTimer';
import { useActiveState, useAppStore, useHydrated, useMocks, useSettings } from '@/store';
import {
  MOCK_DURATION_MS,
  buildMockPaper,
  buildMockResult,
  type MockResponse,
  type MockResponses,
} from '@/lib/mockExam';
import { STATES_BY_CODE } from '@/data/states';
import { OPTION_KEYS, type OptionKey, type Question, type QuestionId, type QuestionTranslations, type StateCode } from '@/types';

/* ───────────────────────── in-progress persistence ───────────────────────
 * A 60-minute exam on a phone WILL be backgrounded and often reloaded (the
 * OS may reclaim a backgrounded tab entirely). `sessionStorage` — not the
 * IndexedDB-backed store, which is for durable cross-device progress — holds
 * just enough to reconstruct the in-progress attempt: the state + seed
 * (which deterministically reconstructs the exact paper via
 * `buildMockPaper`), the start time (for the timer) and the answers given so
 * far. It is deliberately NOT routed through `useAppStore`: an in-progress
 * attempt is not a fact worth syncing to another device or merging, and
 * `finishMock` — the only store write this file makes — fires once, at the
 * end, with the final result.
 */
const STORAGE_KEY = 'mockExam.inProgress.v1';

interface StoredExam {
  readonly state: StateCode;
  readonly seed: number;
  readonly startedAt: number;
  readonly responses: MockResponses;
}

function loadStoredExam(): StoredExam | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { seed?: unknown }).seed !== 'number' ||
      typeof (parsed as { startedAt?: unknown }).startedAt !== 'number' ||
      typeof (parsed as { state?: unknown }).state !== 'string'
    ) {
      return null;
    }
    return parsed as StoredExam;
  } catch {
    return null;
  }
}

function saveStoredExam(value: StoredExam): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* Private-mode storage or quota errors must not break the exam. */
  }
}

function clearStoredExam(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* best-effort */
  }
}

function generateMockId(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return `mock-${c.randomUUID()}`;
  return `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ───────────────────────────────── XP ─────────────────────────────────
 * No XP formula exists yet for any mode (Learn/Drill/Speed are still
 * unbuilt), so this is a first cut, easy to retune later: a small reward per
 * correct answer plus a completion bonus for passing, mirroring how
 * `badge.firstMock` singles out a *pass* rather than a mere attempt.
 */
const XP_PER_CORRECT = 5;
const XP_PASS_BONUS = 50;

type ResponseMap = Readonly<Record<QuestionId, MockResponse>>;

export default function MockExam() {
  const { t } = useT();
  const navigate = useNavigate();
  const hydrated = useHydrated();
  const activeState = useActiveState();
  const settings = useSettings();
  const mocks = useMocks();

  const [phase, setPhase] = useState<'intro' | 'exam'>('intro');
  const [paper, setPaper] = useState<readonly Question[]>([]);
  const [startedAt, setStartedAt] = useState<number>(0);
  const [responses, setResponses] = useState<ResponseMap>({});
  const [index, setIndex] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [translations, setTranslations] = useState<QuestionTranslations | null>(null);

  const resumedRef = useRef(false);
  const submittingRef = useRef(false);
  const confirmDialogRef = useRef<HTMLDivElement | null>(null);

  // Resume an interrupted exam exactly once, on first mount, before the intro ever paints.
  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    if (activeState === null) return;
    const stored = loadStoredExam();
    if (stored === null || stored.state !== activeState) return;
    setPaper(buildMockPaper(stored.state, stored.seed));
    setStartedAt(stored.startedAt);
    setResponses(stored.responses as ResponseMap);
    setPhase('exam');
  }, [activeState]);

  // Keep the in-progress snapshot current so a reload/kill resumes instead of restarting.
  useEffect(() => {
    if (phase !== 'exam' || activeState === null || startedAt === 0) return;
    saveStoredExam({ state: activeState, seed: startedAt, startedAt, responses });
  }, [phase, activeState, startedAt, responses]);

  // Translations are opt-in and lazy: `mockTranslations` off means German only,
  // full stop, no fetch — the real exam has no translations, so the default
  // behaviour must not even request them.
  const translationLocale = settings.mockTranslations ? activeTranslationLocale(settings.translation) : null;
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

  useEffect(() => {
    if (confirmOpen) confirmDialogRef.current?.focus();
  }, [confirmOpen]);

  const currentQuestion = paper[index];
  const unansweredCount = useMemo(
    () => paper.filter((q) => responses[q.id]?.chosen === undefined || responses[q.id]?.chosen === null).length,
    [paper, responses],
  );

  const handleStart = useCallback(() => {
    if (activeState === null) return;
    const now = Date.now();
    const newPaper = buildMockPaper(activeState, now);
    setPaper(newPaper);
    setStartedAt(now);
    setResponses({});
    setIndex(0);
    setConfirmOpen(false);
    setPhase('exam');
    saveStoredExam({ state: activeState, seed: now, startedAt: now, responses: {} });
  }, [activeState]);

  const handleSelect = useCallback(
    (key: OptionKey) => {
      if (currentQuestion === undefined) return;
      const id = currentQuestion.id;
      setResponses((prev) => ({ ...prev, [id]: { chosen: key, answeredAt: Date.now() } }));
    },
    [currentQuestion],
  );

  const handleSubmit = useCallback(() => {
    if (submittingRef.current || activeState === null || paper.length === 0) return;
    submittingRef.current = true;
    setConfirmOpen(false);

    const finishedAt = Date.now();
    const id = generateMockId();
    const result = buildMockResult({ id, state: activeState, startedAt, finishedAt, paper, responses });
    const passedBefore = mocks.some((m) => m.passed);

    clearStoredExam();

    void (async () => {
      await useAppStore.getState().finishMock(result);
      await useAppStore.getState().gainXp(XP_PER_CORRECT * result.correct + (result.passed ? XP_PASS_BONUS : 0));
      if (result.passed && !passedBefore) {
        await useAppStore.getState().grantBadge('firstMock');
      }
      navigate(`/review/${id}`);
    })();
  }, [activeState, paper, startedAt, responses, mocks, navigate]);

  if (!hydrated || activeState === null) {
    return (
      <div className="p-4">
        <p className="text-fg-muted">{t('common.loading')}</p>
      </div>
    );
  }

  if (phase === 'intro') {
    const stateName = STATES_BY_CODE[activeState].name;
    return (
      <div className="mx-auto max-w-md p-4">
        <h1 className="text-2xl font-semibold text-fg">{t('mock.title')}</h1>
        <p className="mt-1 text-fg-muted">{t('mock.intro.title')}</p>
        <ul className="mt-4 space-y-3 text-fg">
          <li>{t('mock.intro.format', { state: stateName })}</li>
          <li>{t('mock.intro.time')}</li>
          <li>{t('mock.intro.pass')}</li>
          <li>{t('mock.intro.noFeedback')}</li>
          <li>{t('mock.intro.germanOnly')}</li>
        </ul>
        <Button variant="primary" className="mt-6 w-full" onClick={handleStart}>
          {t('mock.start')}
        </Button>
      </div>
    );
  }

  if (currentQuestion === undefined) {
    return (
      <div className="p-4">
        <p className="text-fg-muted">{t('common.loading')}</p>
      </div>
    );
  }

  const translation = translationLocale !== null ? translations?.[currentQuestion.id] : undefined;
  const selected = responses[currentQuestion.id]?.chosen ?? null;
  const isLast = index === paper.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      {/* Top bar: progress, unanswered count, timer, always-available submit. */}
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-fg">{t('q.progress', { current: index + 1, total: paper.length })}</span>
          {unansweredCount > 0 && (
            <span className="text-xs text-fg-muted">{t('mock.unanswered', { count: unansweredCount })}</span>
          )}
          <Button variant="ghost" className="justify-start text-accent" onClick={() => setConfirmOpen(true)}>
            {t('mock.submitExam')}
          </Button>
        </div>
        <ExamTimer startedAt={startedAt} durationMs={MOCK_DURATION_MS} onExpire={handleSubmit} />
      </div>

      {/* Question jump strip — a plain group of buttons, not `tablist`/`tab`: those roles imply
          arrow-key roving-tabindex behaviour this simple strip does not implement, and a role
          that promises keyboard behaviour it doesn't deliver is worse than no role at all. */}
      <div
        className="flex gap-2 overflow-x-auto border-b border-line px-4 py-2"
        role="group"
        aria-label={t('q.progress', { current: index + 1, total: paper.length })}
      >
        {paper.map((q, i) => {
          const answered = responses[q.id]?.chosen !== undefined && responses[q.id]?.chosen !== null;
          const isCurrent = i === index;
          return (
            <button
              key={q.id}
              type="button"
              aria-current={isCurrent ? 'true' : undefined}
              aria-label={t('q.number', { number: i + 1 })}
              onClick={() => setIndex(i)}
              className={[
                'inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-full border text-sm font-medium transition-colors',
                isCurrent
                  ? 'border-accent bg-accent text-accent-fg'
                  : answered
                    ? 'border-line bg-surface-raised text-fg'
                    : 'border-line bg-surface text-fg-muted',
              ].join(' ')}
            >
              {i + 1}
            </button>
          );
        })}
      </div>

      {/* Question content, scrollable so long questions/images never push the answers off-screen. */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <p className="text-base font-medium text-fg">{currentQuestion.question}</p>

        {currentQuestion.image !== undefined && (
          <img
            src={asset(currentQuestion.image)}
            alt={t('q.imageAlt', { number: currentQuestion.number })}
            className="mt-3 max-w-full rounded-lg border border-line"
          />
        )}

        {translationLocale !== null && translation !== undefined && (
          <TranslationBlock locale={translationLocale} className="mt-3 rounded-lg bg-surface-raised p-3 text-sm">
            <span className="sr-only">{t('a11y.translationBlock', { language: LOCALE_INFO[translationLocale].endonym })}</span>
            <p>{translation.question}</p>
          </TranslationBlock>
        )}
      </div>

      {/* Answer options, pinned to the bottom thumb zone. No correctness feedback: selection is the
          only state a button carries here — never a right/wrong colour, ever, during the exam. */}
      <div className="border-t border-line bg-surface-raised px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
        <div className="flex flex-col gap-2">
          {OPTION_KEYS.map((key) => {
            const isSelected = selected === key;
            const translatedOption = translationLocale !== null ? translation?.options[key] : undefined;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={isSelected}
                aria-label={t('q.optionLabel', { letter: key.toUpperCase() })}
                onClick={() => handleSelect(key)}
                className={[
                  'min-h-touch rounded-xl border px-4 py-3 text-start transition-colors',
                  isSelected ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface text-fg hover:bg-surface-raised',
                ].join(' ')}
              >
                <span className="block">{currentQuestion.options[key]}</span>
                {translatedOption !== undefined && (
                  <TranslationBlock locale={translationLocale ?? 'en'} className="mt-1 text-sm opacity-80">
                    {translatedOption}
                  </TranslationBlock>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <Button variant="secondary" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0}>
            {t('nav.back')}
          </Button>
          {isLast ? (
            <Button variant="primary" onClick={() => setConfirmOpen(true)}>
              {t('mock.submitExam')}
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setIndex((i) => Math.min(paper.length - 1, i + 1))}>
              {t('q.next')}
            </Button>
          )}
        </div>
      </div>

      {confirmOpen && (
        <div className="fixed inset-0 z-10 flex items-end justify-center bg-fg/40 p-4" role="presentation">
          <div
            ref={confirmDialogRef}
            tabIndex={-1}
            role="alertdialog"
            aria-modal="true"
            aria-label={t('mock.submitExam')}
            className="w-full max-w-md rounded-xl bg-surface-raised p-4 shadow-lg outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setConfirmOpen(false);
            }}
          >
            <p className="text-fg">{t('mock.submit.confirm', { count: unansweredCount })}</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" onClick={handleSubmit}>
                {t('common.confirm')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
