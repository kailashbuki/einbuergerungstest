// The Settings screen: language, Bundesland, practice, appearance, data
// (export/import/snapshots), sync, and the two scoped resets.
//
// No save button, ever. Every control writes through `patchSettings` /
// `switchState` immediately — see `@/store`, the only write path to
// persistence. The interface language and theme already react live via
// `LocaleSync`/`ThemeSync` in `src/App.tsx`, so a single store write is all a
// control here has to do.

import { useId, useState, type ReactNode } from 'react';
import { useT } from '@/i18n/useT';
import { useActiveState, useAppStore, useSettings } from '@/store';
import { isTtsAvailable } from '@/lib/tts';
import { STATES_BY_CODE, type StateCode } from '@/data/states';
import { StatePicker } from '@/components/StatePicker';
import { LanguagePicker } from '@/components/LanguagePicker';
import { SettingRow } from '@/components/SettingRow';
import { Toggle } from '@/components/Toggle';
import { SyncStatusCard } from '@/components/SyncStatusCard';
import { StorageCard } from '@/components/StorageCard';
import { DangerZone } from '@/components/DangerZone';
import { Button } from '@/components/ui/Button';
import type { Settings as SettingsType, ThemeSetting, TranslationSetting, UiLocale } from '@/types';

function patch(p: Partial<SettingsType>): void {
  void useAppStore.getState().patchSettings(p);
}

function Section({ titleKey, children }: { readonly titleKey: string; readonly children: ReactNode }) {
  const { t } = useT();
  return (
    <section className="border-b border-line px-4 py-5 last:border-b-0">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-fg-muted">{t(titleKey)}</h2>
      {children}
    </section>
  );
}

const THEME_OPTIONS: readonly { readonly key: ThemeSetting; readonly labelKey: string }[] = [
  { key: 'light', labelKey: 'set.theme.light' },
  { key: 'dark', labelKey: 'set.theme.dark' },
  { key: 'system', labelKey: 'set.theme.system' },
];

function ThemeControl({ value }: { readonly value: ThemeSetting }) {
  const { t } = useT();
  return (
    <div role="radiogroup" aria-label={t('set.theme')} className="grid grid-cols-3 gap-2">
      {THEME_OPTIONS.map((opt) => {
        const selected = opt.key === value;
        return (
          <button
            key={opt.key}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => patch({ theme: opt.key })}
            className={[
              'min-h-touch rounded-xl border px-3 py-2 text-sm font-medium transition-colors',
              selected
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line bg-surface-raised text-fg hover:border-accent/50',
            ].join(' ')}
          >
            {t(opt.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

/** Bundesland section: shows the current state, a disclosure to change it via `StatePicker`, and the lossless-switch note. */
function StateSection() {
  const { t } = useT();
  const activeState = useActiveState();
  const [changing, setChanging] = useState(false);
  const [switchNote, setSwitchNote] = useState<string | null>(null);

  const currentName = activeState !== null ? STATES_BY_CODE[activeState].name : t('common.none');

  async function handleChange(code: StateCode) {
    const previous = activeState;
    if (previous === code) {
      setChanging(false);
      return;
    }
    await useAppStore.getState().switchState(code);
    if (previous !== null) {
      setSwitchNote(t('state.switch.note', { previous: STATES_BY_CODE[previous].name }));
    }
    setChanging(false);
  }

  return (
    <Section titleKey="set.section.state">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-fg-muted">{t('state.current')}</p>
          <p className="truncate text-base text-fg">{currentName}</p>
        </div>
        <Button variant="secondary" aria-expanded={changing} onClick={() => setChanging((v) => !v)}>
          {t('state.change')}
        </Button>
      </div>

      {switchNote !== null && (
        <p role="status" className="mt-3 text-sm text-fg-muted">
          {switchNote}
        </p>
      )}

      {changing && (
        <div className="mt-4">
          <StatePicker value={activeState} onChange={(code) => void handleChange(code)} searchable />
        </div>
      )}
    </Section>
  );
}

export default function Settings() {
  const { t } = useT();
  const settings = useSettings();
  const ttsAvailable = isTtsAvailable();

  const recallFirstId = useId();
  const ttsId = useId();
  const ttsAutoplayId = useId();
  const alwaysShowTranslationId = useId();
  const mockTranslationsId = useId();

  return (
    <div className="pb-8">
      <h1 className="px-4 pt-4 text-2xl font-semibold text-fg">{t('set.title')}</h1>

      <Section titleKey="set.section.language">
        <p className="mb-2 text-sm text-fg-muted">{t('set.interfaceLanguage.desc')}</p>
        <LanguagePicker
          kind="ui"
          value={settings.uiLocale}
          onChange={(locale: UiLocale) => patch({ uiLocale: locale })}
        />

        <p className="mb-2 mt-5 text-sm text-fg-muted">{t('set.translationLanguage.desc')}</p>
        <LanguagePicker
          kind="translation"
          value={settings.translation}
          onChange={(setting: TranslationSetting) => patch({ translation: setting })}
        />

        <div className="mt-2">
          <SettingRow
            label={t('set.alwaysShowTranslation')}
            description={t('set.alwaysShowTranslation.desc')}
            htmlFor={alwaysShowTranslationId}
            control={
              <Toggle
                id={alwaysShowTranslationId}
                checked={settings.alwaysShowTranslation}
                onChange={(v) => patch({ alwaysShowTranslation: v })}
                label={t('set.alwaysShowTranslation')}
              />
            }
          />
          <SettingRow
            label={t('set.mockTranslations')}
            description={t('set.mockTranslations.desc')}
            htmlFor={mockTranslationsId}
            control={
              <Toggle
                id={mockTranslationsId}
                checked={settings.mockTranslations}
                onChange={(v) => patch({ mockTranslations: v })}
                label={t('set.mockTranslations')}
              />
            }
          />
        </div>
      </Section>

      <StateSection />

      <Section titleKey="set.section.practice">
        <SettingRow
          label={t('set.recallFirst')}
          description={t('set.recallFirst.desc')}
          htmlFor={recallFirstId}
          control={
            <Toggle
              id={recallFirstId}
              checked={settings.recallFirst}
              onChange={(v) => patch({ recallFirst: v })}
              label={t('set.recallFirst')}
            />
          }
        />
        <SettingRow
          label={t('set.tts')}
          description={ttsAvailable ? t('set.tts.desc') : t('set.tts.unavailable')}
          htmlFor={ttsId}
          control={
            <Toggle
              id={ttsId}
              checked={settings.tts}
              disabled={!ttsAvailable}
              onChange={(v) => patch({ tts: v })}
              label={t('set.tts')}
            />
          }
        />
        <SettingRow
          label={t('set.ttsAutoplay')}
          htmlFor={ttsAutoplayId}
          control={
            <Toggle
              id={ttsAutoplayId}
              checked={settings.ttsAutoplay}
              disabled={!ttsAvailable || !settings.tts}
              onChange={(v) => patch({ ttsAutoplay: v })}
              label={t('set.ttsAutoplay')}
            />
          }
        />
      </Section>

      <Section titleKey="set.section.appearance">
        <ThemeControl value={settings.theme} />
      </Section>

      <Section titleKey="set.section.data">
        <StorageCard />
      </Section>

      <Section titleKey="set.section.sync">
        <SyncStatusCard />
      </Section>

      <section className="px-4 py-5">
        <DangerZone />
      </section>
    </div>
  );
}
