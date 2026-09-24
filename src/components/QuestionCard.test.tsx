// jsdom has no IndexedDB; this installs an in-memory implementation on
// globalThis and must come before anything that opens the database.
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { QuestionCard, isPanelQuestion } from './QuestionCard';
import { I18nProvider } from '@/i18n/useT';
import { closeDb, deleteDb } from '@/lib/db';
import { federalQuestions } from '@/lib/deck';
import { useAppStore } from '@/store';
import { eliminatedOptions } from '@/store/session';
import { OPTION_KEYS, type Question, type Settings, type TranslationLocale, type UiLocale } from '@/types';

/** A genuinely empty browser per test: fresh Zustand singleton, fresh IndexedDB. */
async function freshStore(patch: Partial<Settings> = {}): Promise<void> {
  await closeDb();
  await deleteDb();
  useAppStore.setState({
    hydrated: false,
    settings: {
      state: 'BW',
      uiLocale: 'en',
      translation: 'off',
      alwaysShowTranslation: false,
      mockTranslations: false,
      recallFirst: true,
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
  // `hydrate` reads the (empty) database back over the settings we just planted,
  // so re-apply them afterwards.
  useAppStore.setState((s) => ({ settings: { ...s.settings, ...patch } }));
}

function renderCard(node: ReactNode, uiLocale: UiLocale = 'en'): void {
  document.documentElement.dir = '';
  render(createElement(I18nProvider, { initialLocale: uiLocale, children: node }));
}

const deck = federalQuestions();

/** A plain prose question (no picture panel) so options are real, translatable text. */
const prose: Question | undefined = deck.find((q) => !isPanelQuestion(q) && q.image === undefined);

beforeEach(async () => {
  await freshStore();
  document.documentElement.dir = '';
  document.documentElement.lang = '';
});

describe('recall-first', () => {
  it('keeps the options out of the DOM until the user asks for them', async () => {
    expect(prose).toBeDefined();
    if (prose === undefined) return;
    await freshStore({ recallFirst: true });
    const user = userEvent.setup();
    renderCard(<QuestionCard question={prose} onAnswer={() => undefined} />);

    // The question is visible…
    expect(screen.getByText(prose.question)).toBeInTheDocument();
    // …but the options are ABSENT, not merely hidden. Visually hiding them would
    // still leak the answer to a screen reader or a tab press, which would
    // destroy the only thing recall-first exists to do.
    for (const key of OPTION_KEYS) {
      expect(screen.queryByText(prose.options[key])).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /Option A/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Answer in your head first/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show options' }));

    for (const key of OPTION_KEYS) {
      expect(screen.getByText(prose.options[key])).toBeInTheDocument();
    }
  });

  it('shows the options immediately when recall-first is off', async () => {
    expect(prose).toBeDefined();
    if (prose === undefined) return;
    await freshStore({ recallFirst: false });
    renderCard(<QuestionCard question={prose} onAnswer={() => undefined} />);

    expect(screen.queryByRole('button', { name: 'Show options' })).not.toBeInTheDocument();
    for (const key of OPTION_KEYS) {
      expect(screen.getByText(prose.options[key])).toBeInTheDocument();
    }
  });

  it('reports the chosen option exactly once per tap', async () => {
    expect(prose).toBeDefined();
    if (prose === undefined) return;
    await freshStore({ recallFirst: false });
    const chosen: string[] = [];
    const user = userEvent.setup();
    renderCard(<QuestionCard question={prose} onAnswer={(key) => chosen.push(key)} />);

    await user.click(screen.getByText(prose.options.c));
    expect(chosen).toEqual(['c']);
  });
});

describe('localization: UI direction is independent of translation direction', () => {
  it('renders an RTL translation block inside an LTR page without flipping <html dir>', async () => {
    expect(prose).toBeDefined();
    if (prose === undefined) return;
    const arabic: TranslationLocale = 'ar';
    await freshStore({
      uiLocale: 'en',
      translation: arabic,
      alwaysShowTranslation: true,
      recallFirst: false,
    });

    renderCard(<QuestionCard question={prose} onAnswer={() => undefined} />, 'en');

    // The Arabic table loads asynchronously.
    const block = await waitFor(() => {
      const found = document.querySelector(`[data-translation-locale="${arabic}"]`);
      expect(found).not.toBeNull();
      return found;
    });

    // The translated block carries its own direction…
    expect(block?.getAttribute('dir')).toBe('rtl');
    expect(block?.getAttribute('lang')).toBe('ar');

    // …and the document stays LTR, because the *interface* is English. An English
    // UI showing an Arabic translation is a normal, supported combination: a
    // translation must never flip the page it is embedded in.
    expect(document.documentElement.dir).toBe('ltr');

    // The German original is still on screen — the real exam is German-only, so
    // the translation is an aid alongside it, never a replacement.
    expect(screen.getByText(prose.question)).toBeInTheDocument();
    const german = screen.getByText(prose.question);
    expect(german.getAttribute('lang')).toBe('de');
  });

  it('renders no translation block at all when translation is off', async () => {
    expect(prose).toBeDefined();
    if (prose === undefined) return;
    await freshStore({ translation: 'off', recallFirst: false });
    renderCard(<QuestionCard question={prose} onAnswer={() => undefined} />);

    expect(screen.queryByRole('button', { name: 'Show translation' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-translation-locale]')).toBeNull();
  });
});

describe('hint ladder', () => {
  it('eliminates the same two options on every re-render', async () => {
    expect(prose).toBeDefined();
    if (prose === undefined) return;
    await freshStore({ recallFirst: false });

    // Step 2 is the 50/50: two of the three wrong options struck out.
    const expected = eliminatedOptions(prose.id, prose.solution, 2);
    expect(expected).toHaveLength(2);
    expect(expected).not.toContain(prose.solution);

    const view = render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: (
          <QuestionCard
            question={prose}
            hintsUsed={2}
            onHint={() => undefined}
            onAnswer={() => undefined}
          />
        ),
      }),
    );

    const struckLetters = (): readonly string[] =>
      (screen.getByTestId('hint-eliminated').textContent ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

    const first = struckLetters();
    expect(first).toHaveLength(2);

    // Re-render five times. A hint seeded from the clock or from Math.random
    // would let the user leave and come back until the distractor they were
    // unsure about happened to be removed.
    for (let i = 0; i < 5; i += 1) {
      view.rerender(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: (
            <QuestionCard
              question={prose}
              hintsUsed={2}
              onHint={() => undefined}
              onAnswer={() => undefined}
            />
          ),
        }),
      );
      expect(struckLetters()).toEqual(first);
    }

    // The eliminated options are also unclickable, so the 50/50 is real.
    for (const key of expected) {
      const button = screen.getByText(prose.options[key]).closest('button');
      expect(button).toBeDisabled();
    }
    const solutionButton = screen.getByText(prose.options[prose.solution]).closest('button');
    expect(solutionButton).not.toBeDisabled();
  });

  it('never offers a hint when the card has no hint handler (mock exam)', async () => {
    expect(prose).toBeDefined();
    if (prose === undefined) return;
    await freshStore({ recallFirst: false });
    renderCard(<QuestionCard question={prose} bare onAnswer={() => undefined} />);

    expect(screen.queryByRole('button', { name: 'Hint' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /note/i })).not.toBeInTheDocument();
  });
});

describe('picture-panel questions', () => {
  it('recognises the composite-image questions whose options are bare panel numbers', () => {
    const panels = deck.filter(isPanelQuestion);
    expect(panels.length).toBeGreaterThan(0);
    for (const q of panels) {
      expect(q.image).toBeDefined();
      for (const key of OPTION_KEYS) expect(q.options[key].trim()).toMatch(/^\d+$/);
    }
    // Numeric options WITHOUT an image are genuine answers ("how many states?")
    // and must still be treated as prose.
    const numericNoImage = deck.filter(
      (q) => q.image === undefined && OPTION_KEYS.every((k) => /^\d+$/.test(q.options[k].trim())),
    );
    for (const q of numericNoImage) expect(isPanelQuestion(q)).toBe(false);
  });
});
