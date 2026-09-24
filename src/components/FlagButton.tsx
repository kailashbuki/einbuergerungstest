import { useCallback, type ReactNode } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { useT } from '@/i18n/useT';
import { useAppStore, useQuestionProgress } from '@/store';
import type { QuestionId } from '@/types';

function FlagIcon({ filled }: { readonly filled: boolean }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className="h-5 w-5"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 21V4h9l-1 3h6l-1.5 5 1.5 5h-8l-1-3H5" />
    </svg>
  );
}

export interface FlagButtonProps {
  readonly questionId: QuestionId;
  /** Renders the word `q.flagged` next to the icon. Off inside tight toolbars. */
  readonly showLabel?: boolean;
}

/**
 * Flag-for-later toggle. Writes through the app store (`toggleFlag`), never to
 * IndexedDB directly, so the flag reaches disk and the sync outbox in one step
 * and the Drill launcher's `scope=flagged` queue sees it immediately.
 */
export function FlagButton({ questionId, showLabel = false }: FlagButtonProps): ReactNode {
  const { t } = useT();
  const progress = useQuestionProgress(questionId);
  const flagged = progress?.flagged ?? false;
  const toggleFlag = useAppStore((s) => s.toggleFlag);

  const onClick = useCallback(() => {
    void toggleFlag(questionId);
  }, [toggleFlag, questionId]);

  return (
    <span className="inline-flex items-center gap-1">
      <IconButton
        aria-label={flagged ? t('q.unflag') : t('q.flag')}
        aria-pressed={flagged}
        active={flagged}
        onClick={onClick}
      >
        <FlagIcon filled={flagged} />
      </IconButton>
      {showLabel && flagged ? <span className="text-xs text-fg-muted">{t('q.flagged')}</span> : null}
    </span>
  );
}
