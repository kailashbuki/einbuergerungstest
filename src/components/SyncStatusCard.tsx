// The sync panel. Sync is strictly an optional upgrade: the app must be fully
// functional with it unconfigured, and a missing/placeholder Firebase config
// must never crash or block anything.
//
// As this repo stands, `src/lib/firebase.ts` ships with every config field set
// to the `'TODO(user)'` placeholder, so `isFirebaseConfigured()` returns
// `false` and this component renders the calm, informational
// `sync.notConfigured` panel below — no error, no warning, no sign-in button.
// That is the state real users of this checkout will actually see.
//
// The "configured" branch below is written against the `SyncAdapter`
// contract (`@/lib/sync/SyncAdapter`) and never imports `firebase/*` or
// `@/lib/sync/firestore` at the top level — only a dynamic `import()` inside
// `loadAdapter()`, gated by `isFirebaseConfigured()`. That keeps firebase's
// ~200KB out of the app shell for the overwhelming majority of users who
// never configure sync, and it means this file compiles and works whether or
// not `src/lib/sync/firestore.ts` exists yet.

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
import { count as outboxCount } from '@/lib/db/outbox';
import { getDbInfo } from '@/lib/db';
import { Button } from './ui/Button';

const TONE_CLASS: Record<StatusDescription['tone'], string> = {
  neutral: 'text-fg-muted',
  positive: 'text-correct',
  warning: 'text-learning',
  danger: 'text-wrong',
};

/**
 * Resolve a concrete sync adapter, lazily and only when Firebase is actually
 * configured.
 *
 * ── WIRING POINT for the firestore adapter ───────────────────────────────
 * Once `src/lib/sync/firestore.ts` lands, replace the body of the `try` block
 * below with:
 *
 *   const { createFirestoreSyncAdapter } = await import('@/lib/sync/firestore');
 *   return createFirestoreSyncAdapter();
 *
 * (or whatever factory name that module exports). Everything else in this
 * component — status rendering, sign-in/out handlers, pending count — already
 * consumes the adapter purely through the `SyncAdapter` interface, so that is
 * the only line that needs to change.
 */
async function loadAdapter(): Promise<SyncAdapter> {
  if (!isFirebaseConfigured()) return noopSyncAdapter;
  try {
    const mod: unknown = await import('@/lib/sync/firestore');
    const factory = (mod as { createFirestoreSyncAdapter?: () => SyncAdapter }).createFirestoreSyncAdapter;
    return typeof factory === 'function' ? factory() : noopSyncAdapter;
  } catch (err) {
    console.warn('[SyncStatusCard] could not load a sync adapter; staying offline-only', err);
    return noopSyncAdapter;
  }
}

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

  useEffect(() => {
    if (configured) refresh();
  }, [configured, refresh]);

  const handleSignIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await loadAdapter();
      setAdapter(next);
      await next.signIn();
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
      await adapter.pull();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sync error');
    } finally {
      setBusy(false);
    }
  }, [adapter, refresh]);

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
