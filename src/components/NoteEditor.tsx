import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { useAppStore, useQuestionProgress } from '@/store';
import type { QuestionId } from '@/types';

export interface NoteEditorProps {
  readonly questionId: QuestionId;
}

/**
 * The user's private note for one question.
 *
 * Collapsed by default — a note is a deliberate act, and an always-open textarea
 * would eat the space the answer buttons need in the thumb zone. Saving goes
 * through the app store so the note lands on disk and in the sync outbox
 * together; there is no autosave, because a half-typed note syncing to another
 * device is worse than an explicit Save.
 */
export function NoteEditor({ questionId }: NoteEditorProps): ReactNode {
  const { t } = useT();
  const progress = useQuestionProgress(questionId);
  const stored = progress?.note ?? '';
  const setNote = useAppStore((s) => s.setNote);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(stored);
  const [savedAt, setSavedAt] = useState(0);

  // Moving to another question must not carry the previous draft across.
  useEffect(() => {
    setOpen(false);
    setDraft(stored);
    setSavedAt(0);
    // `stored` is intentionally not a dependency: re-running on every keystroke-
    // driven store update would fight the user's own typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId]);

  const save = useCallback(() => {
    void setNote(questionId, draft.trim());
    setSavedAt(Date.now());
  }, [setNote, questionId, draft]);

  const remove = useCallback(() => {
    void setNote(questionId, '');
    setDraft('');
    setSavedAt(0);
    setOpen(false);
  }, [setNote, questionId]);

  const fieldId = `note-${questionId}`;

  if (!open) {
    return (
      <div>
        <Button
          variant="ghost"
          onClick={() => {
            setDraft(stored);
            setOpen(true);
          }}
          aria-expanded={false}
          className="px-3 py-2 text-sm"
        >
          {stored.length > 0 ? t('q.note') : t('q.note.add')}
        </Button>
        {stored.length > 0 ? (
          <p className="mt-1 whitespace-pre-wrap text-sm text-fg-muted">{stored}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-line bg-surface-raised p-3">
      <label htmlFor={fieldId} className="block text-sm font-semibold text-fg">
        {t('q.note')}
      </label>
      <textarea
        id={fieldId}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setSavedAt(0);
        }}
        placeholder={t('q.note.placeholder')}
        rows={3}
        className="mt-2 w-full rounded-xl border border-line bg-surface p-2 text-start text-base text-fg placeholder:text-fg-muted"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button onClick={save} className="px-4 py-2 text-sm">
          {t('q.note.save')}
        </Button>
        {stored.length > 0 ? (
          <Button variant="secondary" onClick={remove} className="px-4 py-2 text-sm">
            {t('q.note.delete')}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => setOpen(false)} className="px-4 py-2 text-sm">
          {t('common.cancel')}
        </Button>
      </div>
      <p aria-live="polite" className="mt-1 min-h-[1.25rem] text-sm text-fg-muted">
        {savedAt > 0 ? t('q.note.saved') : ''}
      </p>
    </div>
  );
}
