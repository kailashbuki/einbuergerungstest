// A level's 0-3 star rating, shared by the world map and (eventually) the
// session-complete screen.
//
// Renders as a single accessible image rather than three independently
// announced icons: the whole row's accessible name already states the count
// via `a11y.starsLabel`, so a screen reader user gets the number even though
// sighted users only see icons. Filled vs. outline stars differ in shape and
// colour together, so the earned/unearned split survives colour-blindness.

import { useT } from '@/i18n/useT';

export interface StarRatingProps {
  readonly earned: 0 | 1 | 2 | 3;
  readonly className?: string;
}

const TOTAL_STARS = 3;

const STAR_PATH = 'M12 3.4l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.8l6-.9z';

export function StarRating({ earned, className }: StarRatingProps) {
  const { t } = useT();
  const label = t('a11y.starsLabel', { count: earned });
  const classes = ['inline-flex items-center gap-0.5', className].filter(Boolean).join(' ');

  return (
    <span role="img" aria-label={label} className={classes}>
      {Array.from({ length: TOTAL_STARS }).map((_, index) => {
        const filled = index < earned;
        return (
          <svg
            key={index}
            viewBox="0 0 24 24"
            width={16}
            height={16}
            aria-hidden="true"
            className={filled ? 'flex-none text-accent' : 'flex-none text-fg-muted'}
            fill={filled ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
          >
            <path d={STAR_PATH} />
          </svg>
        );
      })}
    </span>
  );
}
