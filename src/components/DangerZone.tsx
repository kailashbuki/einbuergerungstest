// The scoped resets and account deletion. Each is destructive and each gets its
// own explicit confirmation step — a real one (a second screen the user must
// actively choose), never a bare button and never `window.confirm`.
//
//  - "Reset this Bundesland" -> `resetCurrentState()`: only the active
//    state's 10 questions; federal progress and every other state survive.
//  - "Reset all progress" -> `resetEverything()`: everything on this device.
//  - "Delete your account" -> `deleteAccount()`: the account itself, not just
//    its contents. Shown only when signed in, because there is otherwise no
//    account to delete — and it must exist at all because a sign-in feature the
//    user cannot undo is one they cannot consent to.

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/useT';
import { useActiveState, useAppStore } from '@/store';
import { STATES_BY_CODE } from '@/data/states';
import { isFirebaseConfigured } from '@/lib/firebase';
import { getSyncAdapter } from '@/lib/sync/driver';
import { Button } from './ui/Button';

type PendingAction = 'state' | 'all' | 'account' | null;

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
  const [signedIn, setSignedIn] = useState(false);

  const stateName = activeState !== null ? STATES_BY_CODE[activeState].name : '';

  // Whether there is an account at all — the only thing this block needs from the
  // session. Read once *and* observed: on a cold page load the adapter's cached
  // account is still null until a session restored from a previous visit settles,
  // so a one-shot read would hide the delete control from exactly the returning
  // signed-in user who came here to use it.
  useEffect(() => {
    if (!isFirebaseConfigured()) return undefined;
    let live = true;
    let unsubscribe: (() => void) | null = null;
    void (async () => {
      try {
        const adapter = await getSyncAdapter();
        if (!live) return;
        setSignedIn(adapter.account() !== null);
        const { supportsAccountObservation } = await import('@/lib/sync/firestore');
        if (live && supportsAccountObservation(adapter)) {
          unsubscribe = adapter.onAccountChanged((account) => {
            setSignedIn(account !== null);
            // The confirmation cannot be left standing over an account that is no
            // longer there: confirming would delete nothing and report failure.
            if (account === null) setPending((p) => (p === 'account' ? null : p));
          });
        }
      } catch {
        // No observation available: the control is offered based on the one-shot
        // read, which is the pre-existing behaviour and not worse than nothing.
      }
    })();
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);

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

  async function confirmDeleteAccount() {
    setBusy(true);
    try {
      // Like `resetEverything()`, this never rejects — the outcome is data. Each
      // of the four values needs its own sentence, because "we tried to delete
      // your account" has four genuinely different endings and three of them are
      // not success. See `DeleteAccountOutcome`.
      const outcome = await useAppStore.getState().deleteAccount();
      switch (outcome) {
        case 'deleted':
          setMessage({ text: t('set.deleteAccount.done'), ok: true });
          setSignedIn(false);
          break;
        case 'cancelled':
          setMessage({ text: t('set.deleteAccount.cancelled'), ok: false });
          break;
        case 'skipped':
          // There was no account. Nothing happened and nothing needs saying.
          setSignedIn(false);
          break;
        default:
          setMessage({ text: t('set.deleteAccount.failed'), ok: false });
      }
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

      {/* Only when there is an account. Offering "delete your account" to someone
          who never made one is noise; hiding it from someone who did is the gap
          that makes sign-in a one-way door. */}
      {signedIn && (
        <div className="border-t border-line pt-4" data-testid="danger-delete-account">
          <p className="text-base text-fg">{t('set.deleteAccount')}</p>
          <p className="mt-1 text-sm text-fg-muted">{t('set.deleteAccount.desc')}</p>

          {pending === 'account' ? (
            <div
              role="alertdialog"
              aria-label={t('set.deleteAccount')}
              className="mt-3 rounded-lg border border-wrong/50 bg-surface p-3"
            >
              <p className="text-sm text-fg">{t('set.deleteAccount.confirm')}</p>
              {/* Google will almost always ask again, because a session restored
                  from a previous visit is too old to authorise a deletion. Saying
                  so first turns an alarming surprise popup into an expected step. */}
              <p className="mt-2 text-xs text-fg-muted">{t('set.deleteAccount.reauth')}</p>
              <div className="mt-3 flex gap-2">
                <Button variant="secondary" onClick={() => setPending(null)} disabled={busy}>
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void confirmDeleteAccount()}
                  disabled={busy}
                >
                  {t('common.confirm')}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" className="mt-3" onClick={() => setPending('account')}>
              {t('set.deleteAccount')}
            </Button>
          )}
        </div>
      )}

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
