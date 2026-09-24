// One level row on the world map.
//
// Always a real `<Link>`, even when soft-locked: `isLevelUnlocked` gates are a
// nudge, never a wall (see `src/lib/curriculum.ts`), so a locked tile must stay
// focusable and navigable and must explain *why* it is locked rather than
// being inert. `worlds.unlockHint` carries the reason, `worlds.enterAnyway`
// carries the way through.

import { Link } from 'react-router-dom';
import type { Level } from '@/types';
import type { LevelGate } from '@/lib/curriculum';
import { useT } from '@/i18n/useT';
import { StarRating } from './StarRating';

export type LevelCta = 'level.start' | 'level.continue' | 'level.replay';

export interface LevelTileProps {
  readonly level: Level;
  readonly gate: LevelGate;
  readonly stars: 0 | 1 | 2 | 3;
  readonly cta: LevelCta;
  readonly recommended: boolean;
}

function LockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={12}
      height={12}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none"
    >
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function LevelTile({ level, gate, stars, cta, recommended }: LevelTileProps) {
  const { t } = useT();
  const locked = !gate.unlocked;
  const ctaLabel = locked ? t('worlds.enterAnyway') : t(cta);

  return (
    <li>
      <Link
        to={`/level/${level.id}`}
        className={[
          'flex min-h-touch items-start gap-3 rounded-xl border p-3 transition-colors',
          recommended ? 'border-accent bg-accent/10' : 'border-line bg-surface-raised hover:border-accent/50',
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-full bg-surface text-xs font-bold text-fg-muted"
        >
          {level.label}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold text-fg">{t('level.title', { name: level.label })}</span>
            {level.boss && (
              <span
                className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent"
                title={t('worlds.boss.desc')}
              >
                {t('worlds.boss')}
              </span>
            )}
            {recommended && (
              <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-fg">
                {t('worlds.recommended')}
              </span>
            )}
            {gate.reason === 'heimat' && (
              <span className="rounded-full border border-line px-2 py-0.5 text-xs text-fg-muted">
                {t('worlds.alwaysOpen')}
              </span>
            )}
            {locked && (
              <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-fg-muted">
                <LockIcon />
                {t('worlds.locked')}
              </span>
            )}
          </span>

          <span className="mt-0.5 block truncate text-sm text-fg-muted">{level.name}</span>

          <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            <StarRating earned={stars} />
            <span>{t('worlds.levelCount', { count: level.questionIds.length })}</span>
          </span>

          {locked && (
            <span className="mt-1 block text-xs text-fg-muted">
              {t('worlds.unlockHint', { percent: gate.requiredPercent })} {t('worlds.nudge')}
            </span>
          )}
        </span>

        <span className="mt-0.5 flex-none self-center text-end text-xs font-medium text-accent">{ctaLabel}</span>
      </Link>
    </li>
  );
}
