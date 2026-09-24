// The sync panel. Sync is strictly an optional upgrade: the app must be fully
// functional with it unconfigured, and a missing/placeholder Firebase config
// must never crash or block anything.
//
// When `src/lib/firebase.ts` still holds `'TODO(user)'` placeholders,
// `isFirebaseConfigured()` returns `false` and this component renders the calm,
// informational `sync.notConfigured` panel below — no error, no warning, no
// sign-in button. A fork with no Firebase project of its own sees exactly that.
//
// The "configured" branch below is written against the `SyncAdapter` contract
// (`@/lib/sync/SyncAdapter`) and never imports `firebase/*` or
// `@/lib/sync/firestore` at the top level — the adapter is resolved through
// `@/lib/sync/driver`, which reaches Firestore only via a dynamic `import()`
// gated on `isFirebaseConfigured()`. That keeps firebase's ~200KB out of the app
// shell for anyone who never configures sync.
//
// This panel reports and triggers; it does not implement sync. The cycle itself
// lives in `@/lib/sync/cycle` and is shared with the app-level background sync,
// so signing in here and loading the page tomorrow do exactly the same thing.

import { useCallback, useEffect, useId, useState } from 'react';
import { useT } from '@/i18n/useT';
import { isFirebaseConfigured } from '@/lib/firebase';
import { noopSyncAdapter } from '@/lib/sync/noop';
import {
  describeStatus,
  readSyncState,
  type StatusDescription,
  type SyncAdapter,
  type SyncState,
} from '@/lib/sync/SyncAdapter';
import { getSyncAdapter, syncInBackground, syncNow } from '@/lib/sync/driver';
import { count as outboxCount } from '@/lib/db/outbox';
import { getDbInfo } from '@/lib/db';
import { useAppStore } from '@/store';
import { Button } from './ui/Button';

const TONE_CLASS: Record<StatusDescription['tone'], string> = {
  neutral: 'text-fg-muted',
  positive: 'text-correct',
  warning: 'text-learning',
  danger: 'text-wrong',
};

export function SyncStatusCard() {
  const { t, formatDate } = useT();
  const headingId = useId();
  const configured = isFirebaseConfigured();

  const [adapter, setAdapter] = useState<SyncAdapter>(noopSyncAdapter);
  const [pending, setPending] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set only by `handleSignIn`, so it reports the merge the user just caused
  // rather than appearing after every background cycle.
  const [justMerged, setJustMerged] = useState(false);
  /** True while the two-option sign-out confirmation is open. */
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  /** Set when the last sign-out also wiped this device. */
  const [justWiped, setJustWiped] = useState(false);
  /**
   * Set when a cycle found this device's document belonged to a different
   * account. The user needs telling, because their previous progress has just
   * disappeared from every screen and the only place it still exists locally is
   * the snapshot list further down Settings.
   */
  const [accountSwitched, setAccountSwitched] = useState(false);
  /**
   * Set when the session ended without the user pressing anything here — access
   * revoked from their Google account, a sign-out in another tab, the account
   * deleted on another device. Without this the panel would go on claiming
   * "Signed in as …" while every write failed.
   */
  const [sessionEnded, setSessionEnded] = useState(false);

  const refresh = useCallback(() => {
    void outboxCount()
      .then(setPending)
      .catch(() => {});
    void getDbInfo()
      .then((info) => setLastSyncAt(info.lastSyncAt))
      .catch(() => {});
  }, []);

  // On mount, adopt the shared adapter (which also adopts a session Firebase
  // restored from a previous visit) and sync, so a returning user sees their
  // account and an up-to-date score without pressing anything. Failures are
  // swallowed by `syncInBackground`: this is work the user did not ask for, and
  // the status line already reflects the outcome.
  useEffect(() => {
    if (!configured) return undefined;
    let live = true;
    let unsubscribe: (() => void) | null = null;
    void (async () => {
      refresh();
      const next = await getSyncAdapter();
      if (!live) return;
      setAdapter(next);

      // Watch for sessions that end outside this tab. Dynamically imported for
      // the same reason as everything else Firestore-shaped here: the predicate
      // lives next to the capability so the two cannot drift, and the chunk is
      // already loaded by the time `getSyncAdapter()` has resolved a configured
      // adapter, so this costs no extra round trip.
      try {
        const { supportsAccountObservation } = await import('@/lib/sync/firestore');
        if (live && supportsAccountObservation(next)) {
          unsubscribe = next.onAccountChanged((account) => {
            setSessionEnded(account === null);
            if (account === null) setJustMerged(false);
            // The adapter is a stable object whose `account()` and `status()`
            // read mutable closure state, so its contents changed but its
            // identity did not — and React re-renders on identity. A shallow
            // copy carries the same method closures and gives the new identity
            // the state update needs.
            setAdapter({ ...next });
            refresh();
          });
        }
      } catch (err) {
        // Not being told about external sign-outs is a degradation, not a
        // failure: the panel still works, it just learns later.
        console.warn('[sync] could not watch the account state', err);
      }

      const result = await syncInBackground();
      if (!live) return;
      if (result.outcome === 'account-switched') setAccountSwitched(true);
      refresh();
    })();
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [configured, refresh]);

  const handleSignIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    setJustMerged(false);
    setJustWiped(false);
    setSessionEnded(false);
    setAccountSwitched(false);
    try {
      const next = await getSyncAdapter();
      setAdapter(next);
      await next.signIn();
      // Merge up rather than clobber: the cycle pulls whatever the cloud has
      // and merges it with existing local progress before pushing back.
      const result = await syncNow();
      if (result.outcome === 'account-switched') {
        // Deliberately *not* `setJustMerged(true)`: nothing was merged. The
        // document on this device belonged to someone else and was quarantined,
        // so claiming "your progress was merged with your account" here would be
        // precisely backwards — and would describe the leak we just prevented.
        setAccountSwitched(true);
      } else {
        // Say so. The first cycle after sign-in uploads the *whole* local
        // document, not just what changes from here on (see `mutationsFromDoc`
        // in `lib/sync/cycle.ts`), and until this line existed nothing in the UI
        // told the user that — `sync.merged` was defined in all 8 locales and
        // rendered nowhere. Confirming what just happened is the other half of
        // the notice shown above the button.
        setJustMerged(true);
      }
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sync error');
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  /**
   * @param wipeLocal `true` for the "and remove it from this device" option.
   *
   * The two options are genuinely different operations, not a confirmation of
   * one: keeping the data is the default because signing out is not a request to
   * delete anything, and wiping it is what makes the app safe to use on a
   * borrowed machine. Neither is reachable without the user choosing it.
   */
  const handleSignOut = useCallback(
    async (wipeLocal: boolean) => {
      setBusy(true);
      setError(null);
      setJustMerged(false);
      setJustWiped(false);
      setSessionEnded(false);
      setAccountSwitched(false);
      try {
        // Sign out first. The wipe is local-only, so doing it while a session is
        // still live would let a background cycle re-pull the account's document
        // straight back onto the device the user is trying to clear.
        await adapter.signOut();
        if (wipeLocal) {
          // `wipeLocalData` never touches the cloud copy — that is the whole
          // distinction from "Reset everything" in the Danger Zone below.
          await useAppStore.getState().wipeLocalData();
          setJustWiped(true);
        }
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'sync error');
      } finally {
        setBusy(false);
        setConfirmingSignOut(false);
      }
    },
    [adapter, refresh],
  );

  const handleSyncNow = useCallback(async () => {
    setBusy(true);
    setError(null);
    setAccountSwitched(false);
    try {
      const result = await syncNow();
      if (result.outcome === 'account-switched') setAccountSwitched(true);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sync error');
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (!configured) {
    return (
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <p className="text-sm text-fg-muted">{t('sync.notConfigured')}</p>
      </div>
    );
  }

  const state: SyncState = readSyncState(adapter, { pending, lastSyncAt, error });
  const description = describeStatus(state.status);
  const toneClass = TONE_CLASS[description.tone];

  return (
    <div className="rounded-xl border border-line bg-surface-raised p-4" aria-labelledby={headingId}>
      <h3 id={headingId} className="sr-only">
        {t('set.section.sync')}
      </h3>
      <p className="text-sm text-fg-muted">{t('sync.desc')}</p>

      {/* Shown only while signed out, i.e. only while the sign-in button below
          is the thing the user is about to press. `sync.desc` is forward-looking
          ("keep your progress on all your devices"); this says what leaves the
          device the moment they tap, which is the part that was missing. */}
      {!state.signedIn && (
        <p className="mt-2 text-sm text-fg-muted" data-testid="sync-upload-notice">
          {t('sync.uploadNotice')}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className={['text-sm font-medium', toneClass].join(' ')}>
          {description.busy ? t('sync.status.syncing') : t(description.i18nKey)}
        </span>
        {state.signedIn ? (
          // Hidden while the choice is open, the way `DangerZone` replaces its
          // trigger with its confirmation. Not just tidier: the keep-my-data
          // option is also labelled "Sign out", and two controls with the same
          // accessible name on screen at once is genuinely ambiguous.
          !confirmingSignOut && (
            <Button variant="secondary" onClick={() => setConfirmingSignOut(true)} disabled={busy}>
              {t('sync.signOut')}
            </Button>
          )
        ) : (
          <Button variant="primary" onClick={() => void handleSignIn()} disabled={busy}>
            {t('sync.signIn')}
          </Button>
        )}
      </div>

      {/* Two named outcomes rather than a yes/no confirmation, because signing
          out on a shared machine and signing out on your own phone want opposite
          things and the button alone cannot tell which one you are doing. The
          data-keeping option is listed first and is the primary: signing out is
          not a request to delete anything. */}
      {confirmingSignOut && state.signedIn && (
        <div
          role="alertdialog"
          aria-label={t('sync.signOut.choice')}
          className="mt-3 rounded-lg border border-line bg-surface p-3"
          data-testid="sync-signout-choice"
        >
          <p className="text-sm text-fg">{t('sync.signOut.choice')}</p>
          <div className="mt-3 space-y-3">
            <div>
              <Button variant="primary" onClick={() => void handleSignOut(false)} disabled={busy}>
                {t('sync.signOut.keep')}
              </Button>
              <p className="mt-1 text-xs text-fg-muted">{t('sync.signOut.keep.desc')}</p>
            </div>
            <div>
              <Button variant="secondary" onClick={() => void handleSignOut(true)} disabled={busy}>
                {t('sync.signOut.wipe')}
              </Button>
              <p className="mt-1 text-xs text-fg-muted">{t('sync.signOut.wipe.desc')}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            className="mt-3"
            onClick={() => setConfirmingSignOut(false)}
            disabled={busy}
          >
            {t('common.cancel')}
          </Button>
        </div>
      )}

      {state.account !== null && (
        <p className="mt-2 text-sm text-fg-muted">
          {t('sync.signedInAs', { account: state.account.email ?? state.account.displayName ?? state.account.uid })}
        </p>
      )}

      {/* `role="status"` because the sign-in popup takes focus away and hands it
          back: a silent visual change at that moment is easy to miss entirely. */}
      {justMerged && state.signedIn && (
        <p role="status" className="mt-2 text-sm text-fg" data-testid="sync-merged">
          {t('sync.merged')}
        </p>
      )}

      {/* The previous account's work vanished from every screen a moment ago.
          Saying where it went is the difference between a safety feature and an
          apparent data loss. */}
      {accountSwitched && (
        <p role="status" className="mt-2 text-sm text-fg" data-testid="sync-account-switched">
          {t('sync.accountSwitched')}
        </p>
      )}

      {/* Only meaningful while signed out — which is exactly when it renders,
          because the observer sets it on the transition *to* null. */}
      {sessionEnded && !state.signedIn && (
        <p role="status" className="mt-2 text-sm text-fg" data-testid="sync-session-ended">
          {t('sync.sessionEnded')}
        </p>
      )}

      {justWiped && (
        <p role="status" className="mt-2 text-sm text-fg" data-testid="sync-wiped">
          {t('sync.signOut.wiped')}
        </p>
      )}

      <p className="mt-2 text-sm text-fg-muted">
        {state.lastSyncAt !== null ? t('sync.lastSync', { time: formatDate(state.lastSyncAt) }) : t('sync.neverSynced')}
      </p>
      <p className="mt-1 text-sm text-fg-muted">
        {state.pending > 0 ? t('sync.pending', { count: state.pending }) : t('sync.pending.none')}
      </p>

      {state.error !== null && <p className="mt-2 text-sm text-wrong">{t('sync.error.detail')}</p>}

      {state.signedIn && (
        <Button variant="secondary" className="mt-3" onClick={() => void handleSyncNow()} disabled={busy}>
          {t('sync.syncNow')}
        </Button>
      )}
    </div>
  );
}
