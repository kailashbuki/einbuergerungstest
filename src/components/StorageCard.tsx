// "Your data": storage persistence, manual export/import, and the automatic
// snapshot list. This is the escape hatch that makes the app trustworthy
// without an account — see `src/lib/transfer.ts`.
//
// Export/import read progress through the store's own slices (never
// `@/lib/db` directly — the store is the only write path) except for the few
// data-layer utilities that have no store equivalent: `getDbInfo`,
// `navigator.storage.persist()` (`@/lib/db/persist`), the snapshot helpers
// (`@/lib/db/snapshots`), and `@/lib/transfer` for the export/import format
// itself.
//
// Import safety: `importProgress()` validates and merges *before* touching
// storage, and only on success do we call `reloadFromDb()` so the UI reflects
// the new data. A bad file never half-applies.

import { useCallback, useEffect, useId, useState, type ChangeEvent } from 'react';
import { useT } from '@/i18n/useT';
import { useAppStore, useBadges, useMocks, usePracticeDays, useProgress, useSessions, useSettings, useXp } from '@/store';
import { DB_VERSION } from '@/lib/db';
import { isPersisted, requestPersistentStorage, type PersistState } from '@/lib/db/persist';
import { listSnapshots, restoreSnapshot, type SnapshotMeta } from '@/lib/db/snapshots';
import { downloadExport, importProgress } from '@/lib/transfer';
import type { ProgressDoc } from '@/types';
import { Button } from './ui/Button';

export function StorageCard() {
  const { t, formatDate } = useT();
  const importInputId = useId();

  const settings = useSettings();
  const progress = useProgress();
  const sessions = useSessions();
  const mocks = useMocks();
  const practiceDays = usePracticeDays();
  const badges = useBadges();
  const xp = useXp();

  const [persisted, setPersisted] = useState<PersistState>('unsupported');
  const [snapshots, setSnapshots] = useState<readonly SnapshotMeta[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [importInvalid, setImportInvalid] = useState(false);
  const [busy, setBusy] = useState(false);

  const refreshSnapshots = useCallback(() => {
    void listSnapshots()
      .then(setSnapshots)
      .catch(() => setSnapshots([]));
  }, []);

  useEffect(() => {
    void isPersisted().then(setPersisted);
    refreshSnapshots();
  }, [refreshSnapshots]);

  /** The whole document, assembled from the store's slices rather than re-reading IndexedDB. */
  const currentDoc = useCallback((): ProgressDoc => {
    return {
      schemaVersion: DB_VERSION,
      settings,
      progress,
      sessions,
      mocks,
      practiceDays,
      badges,
      xp,
      updatedAt: settings.updatedAt,
    };
  }, [settings, progress, sessions, mocks, practiceDays, badges, xp]);

  const handleRequestPersist = useCallback(async () => {
    setBusy(true);
    try {
      const next = await requestPersistentStorage();
      setPersisted(next);
    } finally {
      setBusy(false);
    }
  }, []);

  const handleExport = useCallback(() => {
    const ok = downloadExport(currentDoc());
    if (ok) setMessage(t('set.export.done'));
  }, [currentDoc, t]);

  const handleImportChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file === undefined) return;

      setMessage(null);
      setImportInvalid(false);
      setBusy(true);
      try {
        const text = await file.text();
        const result = await importProgress(text);
        if (!result.ok) {
          console.warn('[StorageCard] import rejected', result.reason, result.detail);
          setImportInvalid(true);
          return;
        }
        await useAppStore.getState().reloadFromDb();
        refreshSnapshots();
        setMessage(t('set.import.done'));
      } catch (err) {
        console.warn('[StorageCard] import threw unexpectedly', err);
        setImportInvalid(true);
      } finally {
        setBusy(false);
      }
    },
    [refreshSnapshots, t],
  );

  const handleRestore = useCallback(
    async (id: number) => {
      setBusy(true);
      setMessage(null);
      try {
        const result = await restoreSnapshot(id);
        if (result.ok) {
          await useAppStore.getState().reloadFromDb();
          refreshSnapshots();
          setMessage(t('set.snapshots.restored'));
        }
      } finally {
        setBusy(false);
      }
    },
    [refreshSnapshots, t],
  );

  return (
    <div className="space-y-4">
      {/* Storage persistence */}
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <p className="text-base text-fg">{t('set.storage.title')}</p>
        <p className="mt-1 text-sm text-fg-muted">
          {persisted === 'granted' && t('set.storage.persisted')}
          {persisted === 'denied' && t('set.storage.notPersisted')}
          {persisted === 'unsupported' && t('set.storage.unsupported')}
        </p>
        {persisted === 'denied' && (
          <Button variant="secondary" className="mt-3" onClick={() => void handleRequestPersist()} disabled={busy}>
            {t('set.storage.request')}
          </Button>
        )}
      </div>

      {/* Export / import */}
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <p className="text-base text-fg">{t('set.export')}</p>
        <p className="mt-1 text-sm text-fg-muted">{t('set.export.desc')}</p>
        <Button variant="secondary" className="mt-3" onClick={handleExport}>
          {t('set.export')}
        </Button>

        <div className="mt-4 border-t border-line pt-4">
          <p className="text-base text-fg">{t('set.import')}</p>
          <p className="mt-1 text-sm text-fg-muted">{t('set.import.desc')}</p>
          <label
            htmlFor={importInputId}
            className={[
              'mt-3 inline-flex min-h-touch min-w-touch items-center justify-center rounded-xl border border-line bg-surface-raised px-5 py-3 text-base font-medium text-fg transition-colors hover:bg-surface',
              busy ? 'pointer-events-none opacity-50' : 'cursor-pointer',
            ].join(' ')}
          >
            {t('set.import')}
          </label>
          <input
            id={importInputId}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            disabled={busy}
            onChange={(e) => void handleImportChange(e)}
          />
        </div>

        {message !== null && (
          <p role="status" className="mt-3 text-sm text-correct">
            {message}
          </p>
        )}
        {importInvalid && (
          <p role="alert" className="mt-3 text-sm text-wrong">
            {t('set.import.invalid')}
          </p>
        )}
      </div>

      {/* Snapshots */}
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <p className="text-base text-fg">{t('set.snapshots.title')}</p>
        <p className="mt-1 text-sm text-fg-muted">{t('set.snapshots.desc')}</p>

        {snapshots.length === 0 ? (
          <p className="mt-3 text-sm text-fg-muted">{t('set.snapshots.empty')}</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {snapshots.map((snap) => (
              <li key={snap.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
                <span className="min-w-0 truncate text-sm text-fg">
                  {t('set.snapshots.item', { date: formatDate(snap.at), questions: snap.questionCount })}
                </span>
                <Button variant="ghost" onClick={() => void handleRestore(snap.id)} disabled={busy}>
                  {t('set.snapshots.restore')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
