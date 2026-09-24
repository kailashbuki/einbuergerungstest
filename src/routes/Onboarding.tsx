// The first-run wizard: three steps, one required decision, no marketing.
//
// Why this screen is the way it is
// ────────────────────────────────
//  1. It is the ONLY exit from the onboarding gate. `useNeedsOnboarding()` is
//     `hydrated && (!onboarded || state === null)`, and every other route
//     redirects here while that is true. So the single most important property
//     of this file is that the final CTA persists `{ state, onboarded: true }`
//     before navigating — otherwise the user is trapped in a loop forever.
//  2. Bundesland is required and has NO default. Guessing would silently teach
//     the wrong 10 state questions, so the forward action stays disabled (with a
//     visible reason) until the user actively picks one.
//  3. Language choices take effect IMMEDIATELY, not on finish. Each tap writes
//     to the store, `App.tsx`'s `LocaleSync` pushes `settings.uiLocale` into the
//     i18n provider, and the remaining steps are therefore already in the user's
//     language. That is also why the selected values are read back out of
//     `useSettings()` instead of being mirrored in local component state: the
//     store is the single source of truth the moment the user taps.
//  4. `state` is written early too (harmless — progress is keyed by question id,
//     never by state), but `onboarded: true` is written ONLY by the final CTA,
//     so the gate cannot let anyone escape mid-wizard.
//
// Layout: mobile-first at 375px, the forward action pinned to the bottom thumb
// zone, own safe-area padding (this route renders outside `Layout`, so there is
// no header or bottom nav to inherit it from). Logical properties only, so the
// whole screen mirrors under `dir="rtl"` with no RTL-specific overrides.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LanguagePicker } from '@/components/LanguagePicker';
import { StatePicker } from '@/components/StatePicker';
import { Button } from '@/components/ui/Button';
import type { StateCode } from '@/data/states';
import { detectTranslationLocale, detectUiLocale } from '@/i18n/index';
import { useT } from '@/i18n/useT';
import { allLevels, curriculumFor } from '@/lib/curriculum';
import { useAppStore, useHydrated, useSettings } from '@/store';
import type { TranslationSetting, UiLocale } from '@/types';

const TOTAL_STEPS = 3;

/** 1 = Bundesland (required), 2 = interface language, 3 = question translations. */
type Step = 1 | 2 | 3;

const HEADING_ID = 'onb-heading';
const REQUIRED_ID = 'onb-state-required';

/**
 * Where the CTA lands: the first level of the first world of the chosen state's
 * curriculum. Falls back to the dashboard rather than throwing — a broken
 * curriculum must not strand a user who has already done everything asked of
 * them.
 */
function firstLevelPath(state: StateCode): string {
  try {
    const worlds = curriculumFor(state).worlds;
    const firstLevel = worlds[0]?.levels[0] ?? allLevels(state)[0];
    if (firstLevel === undefined) return '/';
    return `/level/${encodeURIComponent(firstLevel.id)}`;
  } catch (err) {
    console.error('[onboarding] could not derive a first level; entering the dashboard instead', err);
    return '/';
  }
}

export default function Onboarding() {
  const { t } = useT();
  const navigate = useNavigate();
  const hydrated = useHydrated();
  const settings = useSettings();
  const hydrate = useAppStore((s) => s.hydrate);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const switchState = useAppStore((s) => s.switchState);

  const [step, setStep] = useState<Step>(1);
  const [finishing, setFinishing] = useState(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const seeded = useRef(false);

  // Idempotent: `App` already calls this on boot, but the wizard must also work
  // when it is the very first thing mounted (deep link, or a unit test).
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  /**
   * Seed the two language settings from the browser once, so steps 2 and 3 open
   * pre-selected and *skipping them keeps the detected value* instead of
   * blanking it.
   *
   * Guarded by `updatedAt === 0`, which is only true when settings have never
   * been written on this device. That makes the seed a genuine first-run
   * default: it can never overwrite a choice the user already made, not even if
   * they reload halfway through the wizard.
   */
  useEffect(() => {
    if (!hydrated || seeded.current) return;
    seeded.current = true;
    if (settings.onboarded || settings.updatedAt !== 0) return;
    void patchSettings({ uiLocale: detectUiLocale(), translation: detectTranslationLocale() });
  }, [hydrated, settings.onboarded, settings.updatedAt, patchSettings]);

  // Each step replaces the whole screen, so move focus to the new heading:
  // screen readers announce it and keyboard users don't get dropped at the top
  // of the document.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const chooseState = useCallback(
    (state: StateCode) => {
      // Writing `state` now is deliberate and safe; `onboarded` stays false.
      void switchState(state);
    },
    [switchState],
  );

  const chooseUiLocale = useCallback(
    (uiLocale: UiLocale) => {
      // Immediate, not batched: the rest of the wizard renders in this language.
      void patchSettings({ uiLocale });
    },
    [patchSettings],
  );

  const chooseTranslation = useCallback(
    (translation: TranslationSetting) => {
      void patchSettings({ translation });
    },
    [patchSettings],
  );

  /**
   * The one terminal action. Persists `onboarded: true` and only then navigates,
   * because `/` re-evaluates the gate on every render and would bounce us
   * straight back here if the write were still in flight.
   */
  const finish = useCallback(async () => {
    const state = settings.state;
    if (state === null || finishing) return;
    setFinishing(true);
    try {
      await patchSettings({ state, onboarded: true });
      navigate(firstLevelPath(state), { replace: true });
    } catch (err) {
      // The write failed, so `onboarded` is still false and the gate would send
      // the user right back. Stay put and let them tap again.
      console.error('[onboarding] could not save the first-run settings', err);
      setFinishing(false);
    }
  }, [settings.state, finishing, patchSettings, navigate]);

  const goBack = useCallback(() => {
    setStep((current) => (current === 3 ? 2 : 1));
  }, []);

  const goNext = useCallback(() => {
    if (step === 3) {
      void finish();
      return;
    }
    setStep(step === 1 ? 2 : 3);
  }, [step, finish]);

  // Skipping step 3 has nowhere left to go, so it lands on the same terminal
  // action as the CTA. There is still exactly one *call to action*; skip is the
  // quiet way past an optional choice, and it keeps the seeded default.
  const skip = useCallback(() => {
    if (step === 3) {
      void finish();
      return;
    }
    setStep(3);
  }, [step, finish]);

  // Settings have not been read from IndexedDB yet; rendering pickers now would
  // show defaults that are about to be replaced.
  if (!hydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface p-6 text-fg-muted">
        {t('common.loading')}
      </div>
    );
  }

  const stateChosen = settings.state !== null;
  const isLastStep = step === TOTAL_STEPS;
  const blocked = step === 1 && !stateChosen;

  return (
    <div className="flex min-h-screen flex-col bg-surface text-fg">
      <header className="border-b border-line px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <p data-testid="onb-step" className="text-sm font-medium text-fg-muted">
          {t('onb.step', { current: step, total: TOTAL_STEPS })}
        </p>
        {/* Decorative: the sentence above already says where we are. A block in
            normal flow fills from the inline start, so it mirrors under RTL. */}
        <div aria-hidden="true" className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-raised">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${(step / TOTAL_STEPS) * 100}%` }}
          />
        </div>
      </header>

      <main className="flex-1 px-4 py-5">
        {step === 1 && (
          <section aria-labelledby={HEADING_ID}>
            <h1
              id={HEADING_ID}
              ref={headingRef}
              tabIndex={-1}
              className="text-2xl font-semibold text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('onb.welcome.title')}
            </h1>
            <p className="mt-2 text-fg-muted">{t('onb.welcome.body')}</p>

            <h2 className="mt-6 text-lg font-semibold text-fg">{t('onb.state.title')}</h2>
            <p className="mt-1 text-sm text-fg-muted">{t('onb.state.desc')}</p>

            {/* No `searchable`: all 16 fit on one first-run screen, and a filter
                box would be one more thing to understand before starting. */}
            <StatePicker className="mt-4" value={settings.state} onChange={chooseState} />

            {!stateChosen && (
              <p
                id={REQUIRED_ID}
                className="mt-4 rounded-xl border border-line bg-surface-raised p-3 text-sm text-fg-muted"
              >
                {t('onb.state.required')}
              </p>
            )}
          </section>
        )}

        {step === 2 && (
          <section aria-labelledby={HEADING_ID}>
            <h1
              id={HEADING_ID}
              ref={headingRef}
              tabIndex={-1}
              className="text-2xl font-semibold text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('onb.ui.title')}
            </h1>
            <p className="mt-2 text-fg-muted">{t('onb.ui.desc')}</p>
            <LanguagePicker kind="ui" className="mt-4" value={settings.uiLocale} onChange={chooseUiLocale} />
          </section>
        )}

        {step === 3 && (
          <section aria-labelledby={HEADING_ID}>
            <h1
              id={HEADING_ID}
              ref={headingRef}
              tabIndex={-1}
              className="text-2xl font-semibold text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('onb.translation.title')}
            </h1>
            <p className="mt-2 text-fg-muted">{t('onb.translation.desc')}</p>
            {/* `kind="translation"` renders "Off — German only" as an explicit
                first row, so studying in German is a visible choice. */}
            <LanguagePicker
              kind="translation"
              className="mt-4"
              value={settings.translation}
              onChange={chooseTranslation}
            />
          </section>
        )}
      </main>

      <footer className="border-t border-line bg-surface px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        {/* On every step: none of this is permanent. */}
        <p className="mb-3 text-xs text-fg-muted">{t('onb.notPermanent')}</p>

        <div className="flex items-center gap-2">
          {step > 1 && (
            <Button variant="ghost" data-testid="onb-back" onClick={goBack}>
              {t('onb.back')}
            </Button>
          )}
          {step > 1 && (
            <Button variant="secondary" data-testid="onb-skip" onClick={skip}>
              {t('onb.skip')}
            </Button>
          )}
          <Button
            variant="primary"
            className="flex-1"
            data-testid="onb-primary"
            onClick={goNext}
            disabled={blocked || finishing}
            aria-describedby={blocked ? REQUIRED_ID : undefined}
          >
            {isLastStep ? t('onb.cta') : t('onb.next')}
          </Button>
        </div>
      </footer>
    </div>
  );
}
