// The Drill launcher: "what should I drill right now?"
//
// This screen only counts and links — it never builds or runs a session
// itself. The runner lives at `/drill/run` (owned elsewhere) and reads the
// scope back out of the URL's search params, which is the contract this file
// must honour exactly:
//
//   /drill/run?scope=due
//   /drill/run?scope=nemesis
//   /drill/run?scope=flagged
//   /drill/run?scope=all
//   /drill/run?scope=category&category=<url-encoded CategoryId>
//
// The `category` value is the stable `CategoryId` slug (e.g. `history-geography`),
// not its display label — the runner can validate it with `isCategoryId` from
// `@/data/categories`, exactly the helper that module exports for this purpose.
// Slugs happen to contain no characters `encodeURIComponent` would touch, but
// we still run everything through it: the contract is "url-encoded", not
// "url-safe by luck".

import { Link, useSearchParams } from 'react-router-dom';
import { useT } from '@/i18n/useT';
import { useActiveState, useHydrated, useProgress } from '@/store';
import { activeDeck } from '@/lib/deck';
import { buildNemesis, isDue } from '@/lib/scheduler';
import { categoryStrength } from '@/lib/mastery';
import type { ProgressMap } from '@/lib/progressModel';
import type { Question } from '@/types';

/**
 * "Due for review" deliberately excludes never-seen questions, even though
 * `isDue` itself treats an absent/seen:0 row as due (that reading is correct
 * for composing a first-time learn queue). A brand-new user has answered
 * nothing, so this screen must show them 0 due rather than the whole 310-deck —
 * spaced repetition has nothing to review until something has been reviewed
 * once already.
 */
function countDueForReview(deck: readonly Question[], progress: ProgressMap, now: number): number {
  let count = 0;
  for (const q of deck) {
    const p = progress[q.id];
    if (p !== undefined && p.seen > 0 && isDue(p, now)) count += 1;
  }
  return count;
}

function countFlagged(deck: readonly Question[], progress: ProgressMap): number {
  let count = 0;
  for (const q of deck) {
    if (progress[q.id]?.flagged === true) count += 1;
  }
  return count;
}

function DrillSkeleton({ loadingLabel }: { readonly loadingLabel: string }) {
  return (
    <div className="p-4">
      <span className="sr-only">{loadingLabel}</span>
      <div aria-hidden="true">
        <div className="h-8 w-32 animate-pulse rounded bg-surface-raised" />
        <div className="mt-2 h-4 w-56 animate-pulse rounded bg-surface-raised" />
        <div className="mt-4 flex flex-col gap-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl border border-line bg-surface-raised" />
          ))}
        </div>
      </div>
    </div>
  );
}

interface ScopeCardProps {
  readonly testId: string;
  readonly heading: string;
  readonly desc: string;
  readonly count: number;
  /** Pre-formatted count line shown above the CTA, or `null` when the CTA already states the count. */
  readonly countText: string | null;
  readonly ctaHref: string;
  readonly ctaLabel: string;
  readonly emptyText: string;
  readonly emptyLinkLabel: string;
  readonly highlighted: boolean;
  readonly primary: boolean;
}

/** One drillable scope: due, nemesis, flagged or everything. */
function ScopeCard({
  testId,
  heading,
  desc,
  count,
  countText,
  ctaHref,
  ctaLabel,
  emptyText,
  emptyLinkLabel,
  highlighted,
  primary,
}: ScopeCardProps) {
  const cardClasses = [
    'rounded-2xl border p-4',
    primary ? 'border-accent bg-accent/5' : 'border-line bg-surface-raised',
    highlighted ? 'ring-2 ring-accent' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li className={cardClasses} data-testid={testId} aria-current={highlighted ? 'true' : undefined}>
      <h2 className={['text-lg font-semibold', primary ? 'text-accent' : 'text-fg'].join(' ')}>{heading}</h2>
      {desc !== '' ? <p className="mt-1 text-sm text-fg-muted">{desc}</p> : null}

      {count > 0 ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          {countText !== null ? <span className="text-sm text-fg-muted">{countText}</span> : <span />}
          <Link
            to={ctaHref}
            className={[
              'inline-flex min-h-touch min-w-touch items-center justify-center rounded-xl px-4 py-2',
              'text-sm font-medium transition-opacity hover:opacity-90',
              primary ? 'bg-accent text-accent-fg' : 'border border-line bg-surface text-fg',
            ].join(' ')}
          >
            {ctaLabel}
          </Link>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-sm text-fg-muted">{emptyText}</p>
          <Link
            to="/worlds"
            className="mt-2 inline-flex min-h-touch items-center text-sm font-medium text-accent hover:underline"
          >
            {emptyLinkLabel}
          </Link>
        </div>
      )}
    </li>
  );
}

export default function Drill() {
  const { t, formatPercent } = useT();
  const hydrated = useHydrated();
  const state = useActiveState();
  const progress = useProgress();
  const [searchParams] = useSearchParams();

  // Counts depend on progress that is not loaded yet — a returning user with
  // real progress must never flash "0 due" while IndexedDB is still being read.
  if (!hydrated) {
    return <DrillSkeleton loadingLabel={t('common.loading')} />;
  }

  // `App.tsx`'s OnboardingGate redirects state === null to /onboarding, but
  // this screen must not crash during the brief window before that lands.
  if (state === null) {
    return (
      <div className="p-4">
        <p className="text-fg-muted">{t('common.loading')}</p>
      </div>
    );
  }

  const now = Date.now();
  const deck = activeDeck(state);

  const dueCount = countDueForReview(deck, progress, now);
  const nemesisQuestions = buildNemesis(deck, progress, deck.length);
  const flaggedCount = countFlagged(deck, progress);
  const categories = categoryStrength(deck, progress);
  const allCount = deck.length;

  const scopeParam = searchParams.get('scope');
  const categoryParam = searchParams.get('category');

  const worldsLabel = t('nav.worlds');

  return (
    <div className="p-4">
      <h1 className="text-2xl font-semibold">{t('drill.title')}</h1>
      <p className="mt-1 text-fg-muted">{t('drill.subtitle')}</p>

      <ul className="mt-4 flex flex-col gap-3">
        <ScopeCard
          testId="scope-card-due"
          heading={t('drill.scope.due')}
          desc={t('drill.scope.due.desc')}
          count={dueCount}
          countText={t('drill.dueCount', { count: dueCount })}
          ctaHref="/drill/run?scope=due"
          ctaLabel={t('drill.start')}
          emptyText={t('drill.empty')}
          emptyLinkLabel={worldsLabel}
          highlighted={scopeParam === 'due'}
          primary
        />

        <ScopeCard
          testId="scope-card-nemesis"
          heading={t('drill.scope.nemesis')}
          desc={t('drill.scope.nemesis.desc')}
          count={nemesisQuestions.length}
          countText={null}
          ctaHref="/drill/run?scope=nemesis"
          ctaLabel={t('dash.nemesis.drillThese', { count: nemesisQuestions.length })}
          emptyText={t('dash.nemesis.empty')}
          emptyLinkLabel={worldsLabel}
          highlighted={scopeParam === 'nemesis'}
          primary={false}
        />

        <ScopeCard
          testId="scope-card-flagged"
          heading={t('drill.scope.flagged')}
          desc={t('drill.scope.flagged.desc')}
          count={flaggedCount}
          countText={t('dash.flagged.count', { count: flaggedCount })}
          ctaHref="/drill/run?scope=flagged"
          ctaLabel={t('drill.start')}
          emptyText={t('dash.flagged.empty')}
          emptyLinkLabel={worldsLabel}
          highlighted={scopeParam === 'flagged'}
          primary={false}
        />

        <li
          className={[
            'rounded-2xl border p-4',
            'border-line bg-surface-raised',
            scopeParam === 'category' && categoryParam === null ? 'ring-2 ring-accent' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          data-testid="scope-card-category"
          aria-current={scopeParam === 'category' && categoryParam === null ? 'true' : undefined}
        >
          <h2 className="text-lg font-semibold text-fg">{t('drill.scope.category')}</h2>
          <p className="mt-1 text-sm text-fg-muted">{t('drill.scope.category.desc')}</p>
          <p className="mt-1 text-xs uppercase tracking-wide text-fg-muted">{t('dash.categories.weakestFirst')}</p>

          {categories.length === 0 ? (
            <p className="mt-3 text-sm text-fg-muted">{t('dash.categories.empty')}</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {categories.map((cat) => {
                const label = t(`category.${cat.category}`);
                const rowHighlighted = scopeParam === 'category' && categoryParam === cat.category;
                return (
                  <li
                    key={cat.category}
                    data-testid={`scope-category-${cat.category}`}
                    aria-current={rowHighlighted ? 'true' : undefined}
                    className={[
                      'flex items-center justify-between gap-3 rounded-xl border p-3',
                      rowHighlighted ? 'border-accent ring-2 ring-accent' : 'border-line',
                    ].join(' ')}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-fg">{label}</p>
                      <p className="text-xs text-fg-muted">{formatPercent(cat.strength)}</p>
                    </div>
                    <Link
                      to={`/drill/run?scope=category&category=${encodeURIComponent(cat.category)}`}
                      className="inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-xl border border-line bg-surface px-3 py-2 text-sm font-medium text-fg hover:bg-surface-raised"
                      aria-label={`${t('dash.categories.drillThis')}: ${label}`}
                    >
                      {t('dash.categories.drillThis')}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </li>

        <ScopeCard
          testId="scope-card-all"
          heading={t('drill.scope.all')}
          desc=""
          count={allCount}
          countText={t('drill.count', { count: allCount })}
          ctaHref="/drill/run?scope=all"
          ctaLabel={t('drill.start')}
          emptyText={t('drill.empty')}
          emptyLinkLabel={worldsLabel}
          highlighted={scopeParam === 'all'}
          primary={false}
        />
      </ul>
    </div>
  );
}
