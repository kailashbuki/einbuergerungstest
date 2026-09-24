// The study session runner: one component behind two routes.
//
//  - `/level/:levelId` — learn mode, a curated level of 10–12 questions.
//  - `/drill/run`      — drill mode, configured entirely by search params
//                        (`?scope=…&category=…&ids=…`) so a reload lands the
//                        user back in the same drill instead of a random one.
//                        The `/drill` launcher that links here is owned
//                        elsewhere; this file is only the runner.
//
// Two invariants the whole file is built around:
//
//  1. Sessions are FINITE. The queue is built once, its length is on screen from
//     the first question, and it ends. Nothing here can grow without the user
//     asking (see `fb.requeue`), and there is no infinite scroll to get lost in.
//  2. Nothing is silently lost. Quitting mid-session still writes a
//     `SessionResult` containing exactly the answers that were given — never the
//     unanswered remainder, and never nothing at all.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { FeynmanCard } from '@/components/FeynmanCard';
import { QuestionCard, useQuestionTranslations } from '@/components/QuestionCard';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { isCategoryId, type CategoryId } from '@/data/categories';
import { activeDeck, questionById } from '@/lib/deck';
import { allLevels, isLevelUnlocked, levelById, nextLevel, worldOfLevel } from '@/lib/curriculum';
import {
  CLEAR_THRESHOLD,
  isLevelCleared,
  levelProgressPercent,
  levelStars,
  masteryOf,
} from '@/lib/mastery';
import type { ProgressMap } from '@/lib/progressModel';
import {
  DEFAULT_DRILL_SIZE,
  buildDrill,
  buildNemesis,
  dueQuestions,
  seededRng,
} from '@/lib/scheduler';
import { useActiveState, useAppStore, useHydrated, useProgress } from '@/store';
import {
  canRequeue,
  correctCount,
  currentSlot,
  currentStreak,
  sessionAnswers,
  useSessionStore,
  xpFor,
} from '@/store/session';
import type { Level, OptionKey, Question, QuestionId, SessionResult } from '@/types';

/* ──────────────────────────── drill parameters ──────────────────────────── */

const DRILL_SCOPES = ['due', 'nemesis', 'flagged', 'category', 'all', 'ids'] as const;
type DrillScope = (typeof DRILL_SCOPES)[number];

/**
 * Deliberately forgiving: a hand-edited, truncated or stale URL must drop the
 * user into a sensible drill, never into an error screen. Anything unrecognised
 * becomes `due`, which is the right default for every user in every state.
 */
function parseScope(raw: string | null): DrillScope {
  if (raw === null) return 'due';
  const value = raw.trim().toLowerCase();
  return (DRILL_SCOPES as readonly string[]).includes(value) ? (value as DrillScope) : 'due';
}

function parseSize(raw: string | null): number {
  if (raw === null) return DEFAULT_DRILL_SIZE;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_DRILL_SIZE;
  // Bounded on purpose: a session has to be finishable in one sitting.
  return Math.min(60, value);
}

/**
 * The launcher sends the `CategoryId` *slug* (`history-geography`), never the
 * display label, and runs it through `encodeURIComponent`. An unrecognised value
 * is a stale or hand-edited link: it degrades to the whole deck rather than
 * throwing, because a bookmark must never white-screen the app.
 */
function parseCategory(raw: string | null): CategoryId | null {
  if (raw === null) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed percent-escape — fall through with the raw value, which will
    // simply fail validation below.
  }
  return isCategoryId(decoded) ? decoded : null;
}

function parseIds(raw: string | null): readonly QuestionId[] {
  if (raw === null) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Session ids only need to be unique per device; the sync merge unions by id. */
function sessionId(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ──────────────────────────── queue builders ────────────────────────────── */

interface DrillQueueInput {
  readonly deck: readonly Question[];
  readonly progress: ProgressMap;
  readonly now: number;
  readonly scope: DrillScope;
  readonly category: CategoryId | null;
  readonly size: number;
  readonly ids: readonly QuestionId[];
}

/**
 * Turns the search params into a concrete, finite queue.
 *
 * `nemesis` uses `buildNemesis` (only questions missed ≥3 times, worst first);
 * everything else narrows the deck to a pool and hands it to `buildDrill`, which
 * ranks weakest-first. The rng is seeded from the calendar day so "10 from your
 * weak spots" varies day to day but is stable across a reload on the same day —
 * reloading must not silently hand the user a different drill.
 */
function buildDrillQueue({
  deck,
  progress,
  now,
  scope,
  category,
  size,
  ids,
}: DrillQueueInput): readonly Question[] {
  // An explicit id list (used by "drill the ones you missed") is honoured in the
  // order given and never truncated — it is already exactly what was asked for.
  if (scope === 'ids') {
    const byId = new Map(deck.map((q) => [q.id, q] as const));
    const out: Question[] = [];
    const seen = new Set<QuestionId>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      const q = byId.get(id);
      if (q === undefined) continue;
      seen.add(id);
      out.push(q);
    }
    return out;
  }

  if (scope === 'nemesis') return buildNemesis(deck, progress, size);

  let pool: readonly Question[];
  if (scope === 'flagged') {
    pool = deck.filter((q) => progress[q.id]?.flagged === true);
  } else if (scope === 'category') {
    // An unknown or missing category must not yield an empty screen.
    const filtered = category === null ? deck : deck.filter((q) => q.category === category);
    pool = filtered.length > 0 ? filtered : deck;
  } else if (scope === 'due') {
    // `dueQuestions` counts an unseen question as due, which is correct when
    // composing a first-learn queue but wrong for "due for review": a brand-new
    // user must get "nothing due", not all 310. The launcher's count applies the
    // same `seen > 0` narrowing, and the two have to agree.
    pool = dueQuestions(deck, progress, now).filter((q) => (progress[q.id]?.seen ?? 0) > 0);
  } else {
    pool = deck;
  }

  const daySeed = Math.floor(now / 86_400_000);
  return buildDrill(pool, progress, now, size, seededRng(daySeed));
}

/* ────────────────────────────── the component ───────────────────────────── */

export default function Session(): ReactNode {
  const { t } = useT();
  const navigate = useNavigate();
  const { levelId } = useParams<{ levelId?: string }>();
  const [search] = useSearchParams();

  const hydrated = useHydrated();
  const activeState = useActiveState();
  const progress = useProgress();

  const mode = levelId !== undefined ? 'learn' : 'drill';

  const level: Level | undefined =
    levelId !== undefined && activeState !== null ? levelById(activeState, levelId) : undefined;

  const title = useMemo(() => {
    if (level === undefined || activeState === null) return t('drill.title');
    const world = worldOfLevel(activeState, level.id);
    const base = world?.heimat === true ? world.name : level.name;
    // Boss levels announce themselves — they force recall-first and give no hints.
    return level.boss ? `${base} · ${t('worlds.boss')}` : base;
  }, [level, activeState, t]);

  /* ─────────────────────────── soft unlock gate ──────────────────────────── */
  // A locked level is a nudge, never a wall: `worlds.enterAnyway` always exists.
  const [enteredAnyway, setEnteredAnyway] = useState(false);

  const gate = useMemo(() => {
    if (levelId === undefined || activeState === null) return null;
    const percentByLevel: Record<string, number> = {};
    for (const candidate of allLevels(activeState)) {
      percentByLevel[candidate.id] = levelProgressPercent(candidate.questionIds, progress);
    }
    return isLevelUnlocked(levelId, percentByLevel);
  }, [levelId, activeState, progress]);

  const blockedByGate = gate !== null && !gate.unlocked && !enteredAnyway;

  /* ─────────────────────────── queue construction ────────────────────────── */

  const scope = parseScope(search.get('scope'));
  const category = parseCategory(search.get('category'));
  const size = parseSize(search.get('size'));
  const idsParam = search.get('ids');
  const [replay, setReplay] = useState(0);

  // One string that changes exactly when a *different* session is being asked
  // for. It deliberately excludes `progress`: the queue must not reshuffle
  // itself under the user as they answer.
  const sessionKey = [mode, levelId ?? '', scope, category ?? '', String(size), idsParam ?? '', String(replay)].join(
    '|',
  );

  const start = useSessionStore((s) => s.start);
  const reset = useSessionStore((s) => s.reset);
  const slots = useSessionStore((s) => s.slots);
  const index = useSessionStore((s) => s.index);
  const active = useSessionStore((s) => s.active);
  const paused = useSessionStore((s) => s.paused);
  const finished = useSessionStore((s) => s.finished);

  const startedKeyRef = useRef<string | null>(null);
  const committedRef = useRef(false);
  const starsBeforeRef = useRef<0 | 1 | 2 | 3>(0);

  useEffect(() => {
    if (!hydrated || activeState === null) return;
    if (startedKeyRef.current === sessionKey) return;
    if (mode === 'learn' && level === undefined) return;
    if (blockedByGate) return;

    startedKeyRef.current = sessionKey;
    committedRef.current = false;

    // Read the store imperatively so this effect does not re-run on every write.
    const app = useAppStore.getState();
    const now = Date.now();

    let questionIds: readonly QuestionId[];
    if (level !== undefined) {
      questionIds = level.questionIds.filter((id) => questionById(id) !== undefined);
      starsBeforeRef.current = levelStars(level.questionIds, app.progress);
    } else {
      questionIds = buildDrillQueue({
        deck: activeDeck(activeState),
        progress: app.progress,
        now,
        scope,
        category,
        size,
        ids: parseIds(idsParam),
      }).map((q) => q.id);
      starsBeforeRef.current = 0;
    }

    start({
      mode,
      levelId: level?.id ?? null,
      questionIds,
      // Boss levels force recall-first regardless of the setting: a boss is
      // meant to be the moment you find out whether you actually know it.
      recallFirst: app.settings.recallFirst || (level?.boss ?? false),
      now,
    });
  }, [hydrated, activeState, sessionKey, mode, level, blockedByGate, scope, category, size, idsParam, start]);

  // Leaving the screen drops the runtime session. Nothing persisted is lost —
  // `answer()` already committed every answer as it happened.
  useEffect(() => reset, [reset]);

  /* ───────────────────────── commit on completion ───────────────────────── */

  useEffect(() => {
    if (!active || !finished || committedRef.current) return;
    if (activeState === null) return;
    const state = useSessionStore.getState();
    const answers = sessionAnswers(state);
    // Nothing answered means there is nothing to record — an empty
    // `SessionResult` would only pollute the history and the accuracy charts.
    if (answers.length === 0) return;

    committedRef.current = true;
    const result: SessionResult = {
      id: sessionId(),
      mode: state.mode,
      ...(state.levelId !== null ? { levelId: state.levelId } : {}),
      state: activeState,
      startedAt: state.startedAt,
      finishedAt: Date.now(),
      answers,
      correct: answers.reduce((total, a) => total + (a.correct ? 1 : 0), 0),
      total: answers.length,
    };

    const app = useAppStore.getState();
    void (async () => {
      await app.finishSession(result);
      await app.gainXp(xpFor(answers));
    })();
  }, [active, finished, activeState]);

  /* ──────────────────────────── interaction ─────────────────────────────── */

  const slot = slots[index];
  const question: Question | undefined =
    slot === undefined ? undefined : questionById(slot.questionId);

  const hintsAllowed = mode === 'learn' ? !(level?.boss ?? false) : true;

  const onAnswer = useCallback((key: OptionKey) => {
    const sessionState = useSessionStore.getState();
    const current = currentSlot(sessionState);
    // Guards a double-tap: without this the second tap would call `answer()`
    // twice and double-count the question.
    if (current === undefined || current.answered) return;
    const q = questionById(current.questionId);
    if (q === undefined) return;

    const correct = key === q.solution;
    sessionState.submit(key, correct);
    // Exactly one `answer()` per answer event. It owns the scheduler update,
    // the practice-day streak and the sync outbox.
    void useAppStore.getState().answer(q.id, { correct, hintsUsed: current.hintsUsed });
  }, []);

  const onHint = useCallback(() => useSessionStore.getState().useHint(), []);
  const onReveal = useCallback(() => useSessionStore.getState().revealOptions(), []);
  const onNext = useCallback(() => useSessionStore.getState().advance(), []);
  const onRequeue = useCallback(() => useSessionStore.getState().requeueCurrent(), []);
  const onPauseToggle = useCallback(() => {
    const state = useSessionStore.getState();
    if (state.paused) state.resume();
    else state.pause();
  }, []);

  /* ───────────────── Feynman reversal for mastered questions ─────────────── */
  // A retention check, not a graded answer: the reversal runs *before* the real
  // question, and the real question still produces the only `answer()` call.
  const [reversalDone, setReversalDone] = useState<readonly number[]>([]);
  const { locale: translationLocale, translations } = useQuestionTranslations();

  const showReversal =
    mode === 'learn' &&
    slot !== undefined &&
    !slot.answered &&
    !slot.requeue &&
    !reversalDone.includes(index) &&
    masteryOf(progress[slot.questionId]) === 'mastered';

  const dismissReversal = useCallback(() => {
    setReversalDone((done) => (done.includes(index) ? done : [...done, index]));
  }, [index]);

  /* ─────────────────────────── quit / pause ─────────────────────────────── */

  const [confirmQuit, setConfirmQuit] = useState(false);
  const fallbackHref = mode === 'learn' ? '/worlds' : '/drill';

  const doQuit = useCallback(() => {
    const state = useSessionStore.getState();
    setConfirmQuit(false);
    if (sessionAnswers(state).length === 0) {
      navigate(fallbackHref);
      return;
    }
    // Finishing (rather than navigating away) is what guarantees the commit
    // effect runs and the partial session is recorded.
    state.finish();
  }, [navigate, fallbackHref]);

  /* ───────────────────────────── rendering ─────────────────────────────── */

  if (!hydrated || activeState === null) {
    return <p className="p-6 text-center text-fg-muted">{t('common.loading')}</p>;
  }

  if (mode === 'learn' && level === undefined) {
    return (
      <Shell title={t('level.title', { name: levelId ?? '' })}>
        <p className="text-fg-muted">{t('drill.empty')}</p>
        <Link to="/worlds" className="text-accent underline">
          {t('done.backToWorlds')}
        </Link>
      </Shell>
    );
  }

  if (blockedByGate && gate !== null) {
    return (
      <Shell title={t('worlds.locked')}>
        <p className="text-fg">{t('worlds.unlockHint', { percent: gate.requiredPercent })}</p>
        <p className="text-sm text-fg-muted">
          {t('worlds.progress', { percent: gate.previousPercent })}
        </p>
        <p className="text-sm text-fg-muted">{t('worlds.nudge')}</p>
        <div className="flex flex-col gap-2">
          <Button onClick={() => setEnteredAnyway(true)}>{t('worlds.enterAnyway')}</Button>
          <Link
            to="/worlds"
            className="inline-flex min-h-touch items-center justify-center rounded-xl border border-line px-5 py-3 text-fg"
          >
            {t('done.backToWorlds')}
          </Link>
        </div>
      </Shell>
    );
  }

  // The session store is a module singleton, so a freshly-mounted runner can
  // briefly see the *previous* session's state. Rendering only once the store
  // holds this route's session is what stops a stale summary flashing up.
  const ready = startedKeyRef.current === sessionKey && active;

  if (!ready) {
    return <p className="p-6 text-center text-fg-muted">{t('common.loading')}</p>;
  }

  if (slots.length === 0) {
    return (
      <Shell title={title}>
        <p className="text-fg-muted">{t('drill.empty')}</p>
        <Link to={fallbackHref} className="text-accent underline">
          {mode === 'learn' ? t('done.backToWorlds') : t('drill.title')}
        </Link>
      </Shell>
    );
  }

  if (finished) {
    return (
      <Summary
        level={level}
        starsBefore={starsBeforeRef.current}
        onAgain={() => {
          committedRef.current = false;
          setReversalDone([]);
          setReplay((n) => n + 1);
        }}
      />
    );
  }

  if (slot === undefined || question === undefined) {
    return <p className="p-6 text-center text-fg-muted">{t('common.loading')}</p>;
  }

  const total = slots.length;
  const current = index + 1;
  const percent = Math.round((index / total) * 100);
  const sessionState = useSessionStore.getState();
  const streak = currentStreak(sessionState);

  return (
    // 8rem ≈ the app header plus the fixed bottom nav, so the card's own
    // `mt-auto` thumb zone lands just above the nav rather than behind it.
    <div className="flex min-h-[calc(100dvh-8rem)] flex-col gap-3 p-4">
      <header className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-fg">{title}</h1>
            <p className="text-xs text-fg-muted">
              {t('session.footer', { level: title, current, total, streak })}
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            {/* While paused the centred Resume below is the only resume control:
                two buttons with the same accessible name would be ambiguous to a
                screen reader and pointless to everyone else. */}
            {!paused ? (
              <Button variant="ghost" onClick={onPauseToggle} className="px-3 py-2 text-sm">
                {t('session.pause')}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setConfirmQuit(true)} className="px-3 py-2 text-sm">
              {t('session.quit')}
            </Button>
          </div>
        </div>

        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={t('a11y.progressBar', { percent })}
          className="h-1.5 w-full overflow-hidden rounded-full bg-surface-raised"
        >
          <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      </header>

      {confirmQuit ? (
        <section
          role="alertdialog"
          aria-label={t('session.quit')}
          className="rounded-2xl border border-line bg-surface-raised p-3"
        >
          <p className="text-fg">{t('session.quit.confirm')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button onClick={doQuit} className="px-4 py-2 text-sm">
              {t('session.quit')}
            </Button>
            <Button variant="secondary" onClick={() => setConfirmQuit(false)} className="px-4 py-2 text-sm">
              {t('session.quit.keepGoing')}
            </Button>
          </div>
        </section>
      ) : null}

      {paused ? (
        // The question leaves the DOM while paused: a "pause" that leaves the
        // answer on screen is not a pause.
        <section className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <p className="text-fg-muted">{t('q.progress', { current, total })}</p>
          <Button onClick={onPauseToggle}>{t('session.resume')}</Button>
        </section>
      ) : showReversal ? (
        <FeynmanCard
          key={`reversal-${index}`}
          question={question}
          translation={translations === null ? undefined : translations[question.id]}
          translationLocale={translationLocale}
          onSelfAssess={dismissReversal}
        />
      ) : (
        <QuestionCard
          // Remounting per slot resets the card's own local state (explanation
          // open, translation open) — a requeued question must start clean.
          key={`slot-${index}`}
          question={question}
          hintsUsed={slot.hintsUsed}
          {...(hintsAllowed ? { onHint } : {})}
          optionsRevealed={slot.optionsRevealed}
          onReveal={onReveal}
          chosen={slot.chosen}
          answered={slot.answered}
          onAnswer={onAnswer}
          streak={streak}
          onNext={onNext}
          nextLabel={current >= total ? t('q.finish') : t('q.next')}
          onSkip={onNext}
          requeueState={
            slot.answered && !slot.correct
              ? canRequeue(sessionState, slot.questionId)
                ? 'offer'
                : 'done'
              : 'unavailable'
          }
          onRequeue={onRequeue}
          progressLabel={t('q.progress', { current, total })}
        />
      )}
    </div>
  );
}

/* ──────────────────────────────── chrome ────────────────────────────────── */

function Shell({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-xl font-semibold text-fg">{title}</h1>
      {children}
    </div>
  );
}

/* ──────────────────────────────── summary ───────────────────────────────── */

interface SummaryProps {
  readonly level: Level | undefined;
  readonly starsBefore: 0 | 1 | 2 | 3;
  readonly onAgain: () => void;
}

/**
 * The end of a session: what happened, what it earned, and exactly one obvious
 * next step. Recomputed from live progress plus this run's answers, so the stars
 * and the "cleared" verdict match what the world map will show a second later.
 */
function Summary({ level, starsBefore, onAgain }: SummaryProps): ReactNode {
  const { t, formatPercent } = useT();
  const progress = useProgress();
  const activeState = useActiveState();
  const state = useSessionStore();

  const answers = sessionAnswers(state);
  const correct = correctCount(state);
  const total = answers.length;
  const accuracy = total === 0 ? 0 : correct / total;
  const xp = xpFor(answers);
  const missed = [...new Set(answers.filter((a) => !a.correct).map((a) => a.questionId))];

  const stars = level !== undefined ? levelStars(level.questionIds, progress, answers) : 0;
  const cleared =
    level !== undefined
      ? isLevelCleared(level.questionIds, progress, answers)
      : accuracy >= CLEAR_THRESHOLD;
  const upcoming =
    level !== undefined && activeState !== null ? nextLevel(activeState, level.id) : undefined;

  return (
    <div className="flex flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-semibold text-fg">{t('done.title')}</h1>
        {/* aria-live so the result is announced when it replaces the question. */}
        <div aria-live="polite" className="mt-1 space-y-1">
          <p className="text-base text-fg">{t('done.score', { correct, total })}</p>
          <p className="text-sm text-fg-muted">
            {t('done.accuracy', { percent: Math.round(accuracy * 100) })}
          </p>
          <p className="text-sm text-accent">{t('done.xpEarned', { count: xp })}</p>
        </div>
      </header>

      {total > 0 && correct === total ? (
        <p className="rounded-2xl border border-correct bg-correct/10 p-3 text-fg">{t('done.perfect')}</p>
      ) : null}

      {level !== undefined ? (
        <section className="space-y-1 rounded-2xl border border-line bg-surface-raised p-3">
          <p className="text-sm text-fg" aria-label={t('a11y.starsLabel', { count: stars })}>
            {t('done.starsEarned', { count: stars })}
          </p>
          {stars > starsBefore ? <p className="text-sm text-accent">{t('done.newStars')}</p> : null}
          <p className="text-sm text-fg-muted">
            {cleared
              ? t('done.cleared')
              : t('done.notCleared', { percent: Math.round(CLEAR_THRESHOLD * 100) })}
          </p>
          <p className="text-xs text-fg-muted">
            {t('worlds.progress', {
              percent: levelProgressPercent(level.questionIds, progress),
            })}
          </p>
        </section>
      ) : (
        <p className="text-sm text-fg-muted">{formatPercent(accuracy)}</p>
      )}

      <nav className="flex flex-col gap-2">
        {upcoming !== undefined ? (
          <Link
            to={`/level/${upcoming.id}`}
            className="inline-flex min-h-touch items-center justify-center rounded-xl bg-accent px-5 py-3 text-base font-medium text-accent-fg"
          >
            {t('done.nextLevel')}
          </Link>
        ) : null}

        {missed.length > 0 ? (
          <Link
            to={`/drill/run?scope=ids&ids=${missed.join(',')}`}
            className="inline-flex min-h-touch items-center justify-center rounded-xl border border-line px-5 py-3 text-base font-medium text-fg"
          >
            {t('done.drillMistakes', { count: missed.length })}
          </Link>
        ) : null}

        <Button variant="secondary" onClick={onAgain}>
          {t('done.again')}
        </Button>

        <Link
          to="/worlds"
          className="inline-flex min-h-touch items-center justify-center rounded-xl px-5 py-3 text-base font-medium text-fg-muted"
        >
          {t('done.backToWorlds')}
        </Link>
      </nav>
    </div>
  );
}
