// The learning path: a vertical list of worlds, each expanding to its levels.
//
// On a 37-level map, "where do I go now" is the question this screen must
// answer instantly — see `recommendedLevelId` below, which is the one thing
// computed here rather than inside `WorldCard`/`LevelTile`, because it needs
// the *whole* curriculum's play order (`allLevels`, `nextLevel`), not just one
// world's.

import type { AnswerRecord, SessionResult } from '@/types';
import { allLevels, nextLevel, worldsOf } from '@/lib/curriculum';
import { isLevelCleared } from '@/lib/mastery';
import { useActiveState, useHydrated, useProgress, useSessions } from '@/store';
import { useT } from '@/i18n/useT';
import { WorldCard } from '@/components/WorldCard';

/** The most recent finished session's answers for `levelId`, or `undefined`. */
function lastPassAnswersForLevel(
  sessions: readonly SessionResult[],
  levelId: string,
): readonly AnswerRecord[] | undefined {
  let latest: SessionResult | undefined;
  for (const session of sessions) {
    if (session.levelId !== levelId) continue;
    if (latest === undefined || session.finishedAt > latest.finishedAt) latest = session;
  }
  return latest?.answers;
}

function WorldMapSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-20 animate-pulse rounded-2xl bg-surface-raised" />
      ))}
    </div>
  );
}

export default function WorldMap() {
  const { t } = useT();
  const hydrated = useHydrated();
  const state = useActiveState();
  const progress = useProgress();
  const sessions = useSessions();

  // While IndexedDB is still loading we must not render an all-locked map —
  // that would look wrong (and be wrong) for a returning user with progress.
  if (!hydrated) {
    return (
      <div className="p-4">
        <h1 className="text-2xl font-semibold text-fg">{t('worlds.title')}</h1>
        <div className="mt-4">
          <WorldMapSkeleton />
        </div>
      </div>
    );
  }

  // `useActiveState` can be `null` in principle; `App.tsx`'s onboarding gate
  // redirects before this route is ever reached in that case, but guard
  // anyway rather than crash on a state that has no curriculum.
  if (state === null) {
    return (
      <div className="p-4">
        <h1 className="text-2xl font-semibold text-fg">{t('worlds.title')}</h1>
        <p className="mt-2 text-fg-muted">{t('common.loading')}</p>
      </div>
    );
  }

  const worlds = worldsOf(state);
  const levels = allLevels(state);

  let clearedCount = 0;
  let lastClearedIndex = -1;
  levels.forEach((level, index) => {
    const passAnswers = lastPassAnswersForLevel(sessions, level.id);
    if (isLevelCleared(level.questionIds, progress, passAnswers)) {
      clearedCount += 1;
      lastClearedIndex = index;
    }
  });

  const lastCleared = lastClearedIndex === -1 ? undefined : levels[lastClearedIndex];
  const recommendedLevelId =
    lastCleared === undefined ? levels[0]?.id ?? null : nextLevel(state, lastCleared.id)?.id ?? null;

  return (
    <div className="p-4">
      <header>
        <h1 className="text-2xl font-semibold text-fg">{t('worlds.title')}</h1>
        <p className="mt-1 text-fg-muted">{t('worlds.subtitle', { cleared: clearedCount, total: levels.length })}</p>
      </header>

      <ul className="mt-4 space-y-3">
        {worlds.map((world) => (
          <li key={world.id}>
            <WorldCard world={world} progress={progress} sessions={sessions} recommendedLevelId={recommendedLevelId} />
          </li>
        ))}
      </ul>
    </div>
  );
}
