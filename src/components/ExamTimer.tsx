// The mock-exam countdown.
//
// Resilience to backgrounding: `setInterval` ticks are throttled or fully
// paused by mobile browsers while a tab is backgrounded, and a naive
// "subtract one second per tick" countdown would either freeze (losing no
// time, which is wrong for a strict 60-minute limit) or — worse — resume
// ticking from where it left off and hand the user free minutes. Instead
// this component never counts down: every tick recomputes
// `remaining = (startedAt + durationMs) - Date.now()` from the two fixed
// timestamps, so however long the tab was backgrounded, the very next tick
// (or the `visibilitychange` listener firing the instant the tab regains
// focus, without waiting for the next 1s interval) reports the true
// remaining time.
//
// Screen-reader announcements: a countdown that announces every second via
// `aria-live="assertive"` would be unusable — screen readers would interrupt
// constantly and read nothing else. So the visible digits (a plain, visual
// `aria-hidden` clock) update every second, but the live region backing it
// only speaks at milestones: every 5 minutes while more than 5 minutes
// remain, then every single minute inside the last 5 — roughly how a human
// proctor would call out time. `aria-live="polite"` is used for all of that,
// so it never interrupts. The one moment that *must* interrupt — time
// actually running out, which triggers auto-submit — gets its own one-shot
// `role="alert"` (`aria-live="assertive"`) region instead.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/useT';

export interface ExamTimerProps {
  readonly startedAt: number;
  readonly durationMs: number;
  /** Called exactly once, the first time remaining time reaches zero. */
  readonly onExpire: () => void;
}

const TICK_MS = 1000;

/** Minute marks (remaining, rounded down) that get a live-region announcement. */
const MILESTONE_MINUTES: ReadonlySet<number> = new Set([30, 20, 15, 10, 5, 4, 3, 2, 1]);

function clampToZero(ms: number): number {
  return ms > 0 ? ms : 0;
}

export function ExamTimer({ startedAt, durationMs, onExpire }: ExamTimerProps) {
  const { t, formatNumber } = useT();
  const endAt = startedAt + durationMs;

  const [remainingMs, setRemainingMs] = useState<number>(() => clampToZero(endAt - Date.now()));
  const [politeMessage, setPoliteMessage] = useState<string>('');
  const [expiredMessage, setExpiredMessage] = useState<string>('');
  const lastMilestoneRef = useRef<number | null>(null);
  const expiredRef = useRef(false);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  const recompute = useCallback(() => {
    const remaining = clampToZero(endAt - Date.now());
    setRemainingMs(remaining);

    if (remaining <= 0) {
      if (!expiredRef.current) {
        expiredRef.current = true;
        setExpiredMessage(t('mock.timeUp'));
        onExpireRef.current();
      }
      return;
    }

    const minutesRemaining = Math.floor(remaining / 60_000);
    if (MILESTONE_MINUTES.has(minutesRemaining) && lastMilestoneRef.current !== minutesRemaining) {
      lastMilestoneRef.current = minutesRemaining;
      setPoliteMessage(t('a11y.timer', { minutes: minutesRemaining, seconds: 0 }));
    }
  }, [endAt, t]);

  useEffect(() => {
    recompute();
    const interval = setInterval(recompute, TICK_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') recompute();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [recompute]);

  const minutes = Math.floor(remainingMs / 60_000);
  const seconds = Math.floor((remainingMs % 60_000) / 1000);
  const clock = `${formatNumber(minutes)}:${formatNumber(seconds, { minimumIntegerDigits: 2 })}`;
  const urgent = remainingMs > 0 && remainingMs <= 5 * 60_000;

  return (
    <div className="flex flex-col items-end gap-0.5" role="timer" aria-label={t('mock.timeLeft')}>
      <span className="text-xs uppercase tracking-wide text-fg-muted">{t('mock.timeLeft')}</span>
      <span
        aria-hidden="true"
        className={['text-lg font-semibold tabular-nums', urgent ? 'text-wrong' : 'text-fg'].join(' ')}
      >
        {clock}
      </span>
      {/* Milestone-only, polite: see file header for why this is not a per-second announcer. */}
      <span className="sr-only" role="status" aria-live="polite">
        {politeMessage}
      </span>
      {/* One-shot, assertive: the single moment that must interrupt (time is up, auto-submitting). */}
      <span className="sr-only" role="alert" aria-live="assertive">
        {expiredMessage}
      </span>
    </div>
  );
}
