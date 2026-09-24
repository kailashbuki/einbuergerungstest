// jsdom has no IndexedDB; this installs an in-memory implementation on
// globalThis and must come before anything that opens the database.
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import Session from './Session';
import { I18nProvider } from '@/i18n/useT';
import { allLevels } from '@/lib/curriculum';
import { closeDb, deleteDb } from '@/lib/db';
import { questionById } from '@/lib/deck';
import { useAppStore } from '@/store';
import { useSessionStore } from '@/store/session';
import type { Level, Question, Settings } from '@/types';

async function freshStore(patch: Partial<Settings> = {}): Promise<void> {
  await closeDb();
  await deleteDb();
  useSessionStore.getState().reset();
  useAppStore.setState({
    hydrated: false,
    settings: {
      state: 'BW',
      uiLocale: 'en',
      translation: 'off',
      alwaysShowTranslation: false,
      mockTranslations: false,
      // Options visible up front keeps these tests about the runner's
      // bookkeeping rather than about the reveal interaction.
      recallFirst: false,
      tts: false,
      ttsAutoplay: false,
      theme: 'system',
      onboarded: true,
      updatedAt: 0,
      ...patch,
    },
    progress: {},
    sessions: [],
    mocks: [],
    practiceDays: {},
    badges: {},
    xp: 0,
  });
  await useAppStore.getState().hydrate();
  useAppStore.setState((s) => ({ settings: { ...s.settings, state: 'BW', ...patch } }));
}

function renderLevel(levelId: string): void {
  render(
    createElement(I18nProvider, {
      initialLocale: 'en',
      children: (
        <MemoryRouter initialEntries={[`/level/${levelId}`]}>
          <Routes>
            <Route path="/level/:levelId" element={<Session />} />
            <Route path="/worlds" element={<p>worlds</p>} />
          </Routes>
        </MemoryRouter>
      ),
    }),
  );
}

/**
 * Same tree as `renderLevel`, but wrapped in `<StrictMode>` and returning the
 * unmount handle — the two things needed to reproduce a remount.
 */
function renderLevelStrict(levelId: string): { unmount: () => void } {
  return render(
    createElement(StrictMode, {
      children: createElement(I18nProvider, {
        initialLocale: 'en',
        children: (
          <MemoryRouter initialEntries={[`/level/${levelId}`]}>
            <Routes>
              <Route path="/level/:levelId" element={<Session />} />
              <Route path="/worlds" element={<p>worlds</p>} />
            </Routes>
          </MemoryRouter>
        ),
      }),
    }),
  );
}

/** The first level of the first world is always unlocked, so no gate interferes. */
function firstLevel(): Level {
  const levels = allLevels('BW');
  const level = levels[0];
  if (level === undefined) throw new Error('curriculum has no levels');
  return level;
}

function questionsOf(level: Level): readonly Question[] {
  return level.questionIds
    .map((id) => questionById(id))
    .filter((q): q is Question => q !== undefined);
}

/** Clicks the option button holding the correct answer for the question on screen. */
async function answerCurrent(
  user: ReturnType<typeof userEvent.setup>,
  question: Question,
  correct: boolean,
): Promise<void> {
  const key = correct
    ? question.solution
    : (['a', 'b', 'c', 'd'] as const).find((k) => k !== question.solution) ?? 'a';
  await user.click(screen.getByText(question.options[key]));
}

beforeEach(async () => {
  await freshStore();
});

describe('answering persists progress', () => {
  it('records a correct answer as correct: 1 and consecutiveCorrect: 1', async () => {
    const level = firstLevel();
    const questions = questionsOf(level);
    const first = questions[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    const user = userEvent.setup();
    renderLevel(level.id);

    await screen.findByText(first.question);
    await answerCurrent(user, first, true);

    await waitFor(() => {
      const progress = useAppStore.getState().progress[first.id];
      expect(progress).toBeDefined();
      expect(progress?.seen).toBe(1);
      expect(progress?.correct).toBe(1);
      expect(progress?.wrong).toBe(0);
      expect(progress?.consecutiveCorrect).toBe(1);
      // No hint was taken, so the question is still eligible for three stars.
      expect(progress?.hintsUsed).toBe(0);
      // The scheduler has moved it into the future.
      expect(progress?.dueAt ?? 0).toBeGreaterThan(progress?.lastSeen ?? 0);
    });

    // Exactly one answer was recorded — a single tap must not double-count.
    expect(useAppStore.getState().progress[first.id]?.seen).toBe(1);
  });

  it('records a wrong answer without inflating the correct count', async () => {
    const level = firstLevel();
    const first = questionsOf(level)[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    const user = userEvent.setup();
    renderLevel(level.id);
    await screen.findByText(first.question);
    await answerCurrent(user, first, false);

    await waitFor(() => {
      const progress = useAppStore.getState().progress[first.id];
      expect(progress?.wrong).toBe(1);
      expect(progress?.correct).toBe(0);
      expect(progress?.consecutiveCorrect).toBe(0);
    });
  });
});

describe('quitting mid-session', () => {
  it('records a SessionResult containing only the questions actually answered', async () => {
    const level = firstLevel();
    const questions = questionsOf(level);
    expect(questions.length).toBeGreaterThan(2);
    const first = questions[0];
    const second = questions[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    const user = userEvent.setup();
    renderLevel(level.id);

    await screen.findByText(first.question);
    await answerCurrent(user, first, true);
    await user.click(screen.getByRole('button', { name: 'Next' }));

    await screen.findByText(second.question);
    await answerCurrent(user, second, false);

    // Quit is a two-step confirmation: an accidental tap must not end a session.
    await user.click(screen.getByRole('button', { name: 'End session' }));
    expect(screen.getByText(/End this session\?/i)).toBeInTheDocument();
    const dialog = screen.getByRole('alertdialog');
    await user.click(
      [...dialog.querySelectorAll('button')].find(
        (b) => (b.textContent ?? '').trim() === 'End session',
      ) ?? dialog,
    );

    await waitFor(() => {
      expect(useAppStore.getState().sessions.length).toBe(1);
    });

    const result = useAppStore.getState().sessions[0];
    expect(result).toBeDefined();
    if (result === undefined) return;

    // Only the two answered questions — never the unanswered remainder, and
    // never an empty record that would silently lose the user's work.
    expect(result.answers).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.correct).toBe(1);
    expect(result.answers.map((a) => a.questionId)).toEqual([first.id, second.id]);
    expect(result.mode).toBe('learn');
    expect(result.levelId).toBe(level.id);
    expect(result.state).toBe('BW');
    expect(result.finishedAt).toBeGreaterThanOrEqual(result.startedAt);

    // Every answer carries its own hint cost and timing.
    for (const answer of result.answers) {
      expect(answer.hintsUsed).toBe(0);
      expect(answer.chosen).not.toBeNull();
    }

    // XP was granted for the one correct answer.
    //
    // This needs its own `waitFor`: the commit awaits `finishSession()` and then
    // `gainXp()`, so the `sessions.length === 1` wait above only proves the first
    // of the two landed. Asserting XP synchronously after it is a race that
    // happens to pass on a fast machine.
    await waitFor(() => {
      expect(useAppStore.getState().xp).toBe(10);
    });
  });

  it('leaves without a record when nothing was answered', async () => {
    const level = firstLevel();
    const first = questionsOf(level)[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    const user = userEvent.setup();
    renderLevel(level.id);
    await screen.findByText(first.question);

    await user.click(screen.getByRole('button', { name: 'End session' }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(
      [...dialog.querySelectorAll('button')].find(
        (b) => (b.textContent ?? '').trim() === 'End session',
      ) ?? dialog,
    );

    // An empty session would only pollute the history and drag the accuracy
    // charts down with a 0/0.
    await screen.findByText('worlds');
    expect(useAppStore.getState().sessions).toHaveLength(0);
  });

  it('keeps going when the confirmation is declined', async () => {
    const level = firstLevel();
    const first = questionsOf(level)[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    const user = userEvent.setup();
    renderLevel(level.id);
    await screen.findByText(first.question);

    await user.click(screen.getByRole('button', { name: 'End session' }));
    await user.click(screen.getByRole('button', { name: 'Keep going' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText(first.question)).toBeInTheDocument();
    expect(useAppStore.getState().sessions).toHaveLength(0);
  });
});

describe('pausing', () => {
  it('removes the question from the DOM entirely', async () => {
    const level = firstLevel();
    const first = questionsOf(level)[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    const user = userEvent.setup();
    renderLevel(level.id);
    await screen.findByText(first.question);

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    // A "pause" that leaves the question and its options on screen is not a
    // pause — it is a free look.
    expect(screen.queryByText(first.question)).not.toBeInTheDocument();
    expect(screen.queryByText(first.options[first.solution])).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.getByText(first.question)).toBeInTheDocument();
  });
});

describe('finishing the queue', () => {
  it('shows the summary and records the full session', async () => {
    const level = firstLevel();
    const questions = questionsOf(level);
    const user = userEvent.setup();
    renderLevel(level.id);

    for (let i = 0; i < questions.length; i += 1) {
      const question = questions[i];
      if (question === undefined) continue;
      await screen.findByText(question.question);
      await answerCurrent(user, question, true);
      const label = i === questions.length - 1 ? 'Finish' : 'Next';
      await user.click(screen.getByRole('button', { name: label }));
    }

    await screen.findByText('Session complete');
    await waitFor(() => {
      expect(useAppStore.getState().sessions).toHaveLength(1);
    });
    const result = useAppStore.getState().sessions[0];
    expect(result?.total).toBe(questions.length);
    expect(result?.correct).toBe(questions.length);
  });
});

/**
 * Regression: the runner used to park on "Loading…" forever whenever it was
 * remounted, which in practice meant learn mode was completely unreachable in
 * development.
 *
 * The cause was an asymmetric teardown. `startedKeyRef` guards the queue-building
 * effect so it does not reshuffle the queue on every store write, and a separate
 * cleanup resets the runtime session store on unmount. Those two have to be
 * dropped together: reset the store but keep the ref, and the remounted effect
 * skips itself because the ref still says "this session is already started",
 * leaving `active === false` with nothing to render.
 *
 * StrictMode's development-only mount → unmount → mount is the case that actually
 * shipped, so it is tested directly rather than via a hand-rolled remount alone.
 */
describe('the runner survives a remount', () => {
  it('renders the first question under StrictMode, which mounts twice', async () => {
    const level = firstLevel();
    const first = questionsOf(level)[0];
    if (first === undefined) throw new Error('level has no questions');

    renderLevelStrict(level.id);

    // Before the fix this rejected: the screen held `common.loading` forever.
    expect(await screen.findByText(first.question)).toBeTruthy();
    expect(useSessionStore.getState().active).toBe(true);
  });

  it('rebuilds the session after a real unmount and remount', async () => {
    const level = firstLevel();
    const first = questionsOf(level)[0];
    if (first === undefined) throw new Error('level has no questions');

    const { unmount } = renderLevelStrict(level.id);
    await screen.findByText(first.question);

    unmount();
    // Unmounting must actually drop the runtime session — progress is already
    // persisted by `answer()`, so there is nothing to keep here.
    expect(useSessionStore.getState().active).toBe(false);

    renderLevelStrict(level.id);
    expect(await screen.findByText(first.question)).toBeTruthy();
    expect(useSessionStore.getState().active).toBe(true);
  });
});
