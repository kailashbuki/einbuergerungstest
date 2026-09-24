// The two scoped resets. Each is destructive and each gets its own explicit
// confirmation step — a real one (a second screen the user must actively
// choose), never a bare button and never `window.confirm`.
//
//  - "Reset this Bundesland" -> `resetCurrentState()`: only the active
//    state's 10 questions; federal progress and every other state survive.
//  - "Reset all progress" -> `resetEverything()`: everything on this device.

import { useState } from 'react';
import { useT } from '@/i18n/useT';
import { useActiveState, useAppStore } from '@/store';
import { STATES_BY_CODE } from '@/data/states';
import { Button } from './ui/Button';

type PendingAction = 'state' | 'all' | null;

/** A result line: green when the reset fully succeeded, red when the cloud copy survived. */
interface Outcome {
  readonly text: string;
  readonly ok: boolean;
}

export function DangerZone() {
  const { t } = useT();
  const activeState = useActiveState();
  const [pending, setPending] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Outcome | null>(null);

  const stateName = activeState !== null ? STATES_BY_CODE[activeState].name : '';

  async function confirmResetState() {
    setBusy(true);
    try {
      await useAppStore.getState().resetCurrentState();
      setMessage({ text: t('set.reset.done'), ok: true });
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  async function confirmResetAll() {
    setBusy(true);
    try {
      // `resetEverything()` never rejects: the local wipe either happened or the
      // whole store is unusable anyway. What it *reports* is whether the cloud
      // copy went with it. `failed` means data the user asked us to destroy may
      // still exist in their account, so we must not print "Progress reset."
      const { cloud } = await useAppStore.getState().resetEverything();
      setMessage(
        cloud === 'failed'
          ? { text: t('set.reset.cloudFailed'), ok: false }
          : { text: t('set.reset.done'), ok: true },
      );
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-wrong/40 bg-surface-raised p-4">
      {activeState !== null && (
        <div className="border-b border-line pb-4">
          <p className="text-base text-fg">{t('state.reset.state', { state: stateName })}</p>
          <p className="mt-1 text-sm text-fg-muted">{t('state.reset.state.desc')}</p>

          {pending === 'state' ? (
            <div role="alertdialog" aria-label={t('state.reset.state', { state: stateName })} className="mt-3 rounded-lg border border-wrong/50 bg-surface p-3">
              <p className="text-sm text-fg">{t('state.reset.state.desc')}</p>
              <div className="mt-3 flex gap-2">
                <Button variant="secondary" onClick={() => setPending(null)} disabled={busy}>
                  {t('common.cancel')}
                </Button>
                <Button variant="primary" onClick={() => void confirmResetState()} disabled={busy}>
                  {t('common.confirm')}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" className="mt-3" onClick={() => setPending('state')}>
              {t('state.reset.state', { state: stateName })}
            </Button>
          )}
        </div>
      )}

      <div>
        <p className="text-base text-fg">{t('state.reset.all')}</p>
        <p className="mt-1 text-sm text-fg-muted">{t('set.reset.desc')}</p>

        {pending === 'all' ? (
          <div role="alertdialog" aria-label={t('state.reset.all')} className="mt-3 rounded-lg border border-wrong/50 bg-surface p-3">
            <p className="text-sm text-fg">{t('set.reset.confirm')}</p>
            {/* The merge has no tombstones, so a deletion cannot win against
                another signed-in device that still holds a full copy: it will
                re-upload on its next push. Say so before the user acts, not
                after they discover their progress came back. */}
            <p className="mt-2 text-xs text-fg-muted">{t('set.reset.otherDevices')}</p>
            <div className="mt-3 flex gap-2">
              <Button variant="secondary" onClick={() => setPending(null)} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" onClick={() => void confirmResetAll()} disabled={busy}>
                {t('common.confirm')}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" className="mt-3" onClick={() => setPending('all')}>
            {t('state.reset.all')}
          </Button>
        )}
      </div>

      {message !== null && (
        <p
          role="status"
          className={['text-sm', message.ok ? 'text-correct' : 'text-wrong'].join(' ')}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
