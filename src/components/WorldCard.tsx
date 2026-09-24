// One world's card on the world map: header (name, completion, star total)
// plus its levels.
//
// A world is never locked as a whole by curriculum design — `isLevelUnlocked`
// always opens the first level of every world (`reason: 'first-in-world'`) —
// so all gating lives on the individual `LevelTile`s, not here.

import { useState, type SyntheticEvent } from 'react';
import type { AnswerRecord, SessionResult, World } from '@/types';
import type { ProgressMap } from '@/lib/progressModel';
import { isLevelUnlocked } from '@/lib/curriculum';
import { isLevelCleared, levelProgressPercent, levelStars } from '@/lib/mastery';
import { useT } from '@/i18n/useT';
import { LevelTile, type LevelCta } from './LevelTile';

export interface WorldCardProps {
  readonly world: World;
  readonly progress: ProgressMap;
  readonly sessions: readonly SessionResult[];
  /** The single level the map recommends playing next, or `null` if none. */
  readonly recommendedLevelId: string | null;
}

/**
 * The most recent finished session for `levelId`, whose answers count as "one
 * supplied pass" for `levelStars`/`isLevelCleared`. `undefined` when the level
 * has never been played to completion.
 */
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

function levelCta(
  questionIds: readonly string[],
  progress: ProgressMap,
  passAnswers: readonly AnswerRecord[] | undefined,
): LevelCta {
  const started = questionIds.some((id) => (progress[id]?.seen ?? 0) > 0);
  if (!started) return 'level.start';
  return isLevelCleared(questionIds, progress, passAnswers) ? 'level.replay' : 'level.continue';
}

export function WorldCard({ world, progress, sessions, recommendedLevelId }: WorldCardProps) {
  const { t } = useT();
  const [open, setOpen] = useState(true);

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    setOpen(event.currentTarget.open);
  };

  const allQuestionIds = world.levels.flatMap((level) => level.questionIds);
  const percent = levelProgressPercent(allQuestionIds, progress);

  // Gating only ever looks at the previous level within the *same* world (see
  // `FEDERAL_LEVEL_POSITIONS` in curriculum.ts), so a percent map scoped to
  // this world's own levels is all `isLevelUnlocked` ever needs.
  const percentByLevel: Record<string, number> = {};
  for (const level of world.levels) {
    percentByLevel[level.id] = levelProgressPercent(level.questionIds, progress);
  }

  let starsEarned = 0;
  for (const level of world.levels) {
    starsEarned += levelStars(level.questionIds, progress, lastPassAnswersForLevel(sessions, level.id));
  }
  const starsTotal = world.levels.length * 3;

  return (
    <details
      open={open}
      onToggle={handleToggle}
      className={[
        'rounded-2xl border p-3',
        world.heimat ? 'border-accent bg-accent/5' : 'border-line bg-surface-raised',
      ].join(' ')}
    >
      <summary className="flex min-h-touch cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-base font-semibold text-fg">{world.name}</span>
            {world.heimat && (
              <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-fg">
                {t('worlds.alwaysOpen')}
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-xs text-fg-muted">{t('worlds.progress', { percent })}</span>
        </span>
        {/* No dedicated i18n key exists for "N of M stars" at world scope
            (`worlds.stars` is fixed to a denominator of 3, per-level); reusing
            the generic `common.of` here rather than inventing a key. */}
        <span className="flex-none text-xs font-medium text-fg-muted">
          {t('common.of', { current: starsEarned, total: starsTotal })}
        </span>
      </summary>

      <ul className="mt-3 space-y-2">
        {world.levels.map((level) => {
          const gate = isLevelUnlocked(level.id, percentByLevel);
          const passAnswers = lastPassAnswersForLevel(sessions, level.id);
          const stars = levelStars(level.questionIds, progress, passAnswers);
          const cta = levelCta(level.questionIds, progress, passAnswers);
          return (
            <LevelTile
              key={level.id}
              level={level}
              gate={gate}
              stars={stars}
              cta={cta}
              recommended={level.id === recommendedLevelId}
            />
          );
        })}
      </ul>
    </details>
  );
}
