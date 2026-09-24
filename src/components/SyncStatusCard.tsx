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
    void (async () => {
      refresh();
      const next = await getSyncAdapter();
      if (!live) return;
      setAdapter(next);
      await syncInBackground();
      if (live) refresh();
    })();
    return () => {
      live = false;
    };
  }, [configured, refresh]);

  const handleSignIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await getSyncAdapter();
      setAdapter(next);
      await next.signIn();
      // Merge up rather than clobber: the cycle pulls whatever the cloud has
      // and merges it with existing local progress before pushing back.
      await syncNow();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sync error');
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const handleSignOut = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await adapter.signOut();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sync error');
    } finally {
      setBusy(false);
    }
  }, [adapter, refresh]);

  const handleSyncNow = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await syncNow();
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

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className={['text-sm font-medium', toneClass].join(' ')}>
          {description.busy ? t('sync.status.syncing') : t(description.i18nKey)}
        </span>
        {state.signedIn ? (
          <Button variant="secondary" onClick={() => void handleSignOut()} disabled={busy}>
            {t('sync.signOut')}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void handleSignIn()} disabled={busy}>
            {t('sync.signIn')}
          </Button>
        )}
      </div>

      {state.account !== null && (
        <p className="mt-2 text-sm text-fg-muted">
          {t('sync.signedInAs', { account: state.account.email ?? state.account.displayName ?? state.account.uid })}
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
