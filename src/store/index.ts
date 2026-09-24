// The app store — the ONLY write path from the UI to persistence.
//
// Rules this module exists to enforce:
//
//  1. No React component ever calls `src/lib/db/*` directly. Every mutation
//     goes through an action here, which (a) writes to IndexedDB, (b) enqueues
//     an outbox `Mutation` for the sync layer, and (c) updates the in-memory
//     snapshot. Doing those three things in one place is what keeps local state,
//     disk and the sync queue from drifting apart.
//  2. IndexedDB is the source of truth; this store is a cache of it. `hydrate()`
//     fills it on boot and `reloadFromDb()` re-reads it after an import or a
//     sync pull replaces the document wholesale.
//  3. Progress is keyed by question id and is NEVER scoped by the active state.
//     That is the whole reason switching Bundesland is lossless: federal
//     progress is shared by definition, and the previous state's rows simply
//     stop being in the active deck without being touched. See `switchState`.
//
// `settings.state` is `null` until onboarding picks one. Callers that need a
// definite state must handle `null` rather than defaulting to a state the user
// never chose — a wrong default would silently teach the wrong 10 questions.

import { create } from 'zustand';
import {
  addXp as dbAddXp,
  appendMock,
  appendSession,
  awardBadge as dbAwardBadge,
  dayKey,
  loadProgressDoc,
  markPracticeDay,
  putQuestionProgress,
  resetAll as dbResetAll,
  resetState as dbResetState,
  saveSettings,
} from '@/lib/db';
import { enqueue } from '@/lib/db/outbox';
import { recordAnswer, setFlag, setNote as applyNote, type ProgressMap } from '@/lib/progressModel';
import type { StateCode } from '@/data/states';
import type {
  MockResult,
  Mutation,
  PracticeDays,
  QuestionId,
  QuestionProgress,
  SessionResult,
  Settings,
} from '@/types';

/** Outbox mutation ids only need to be unique per device; the merge dedupes by id. */
function mutationId(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Enqueue is best-effort: sync is an optional upgrade, so a failure to record a
 * mutation must never fail the user's answer. The local write already happened
 * and IndexedDB remains correct; the worst case is that this one change reaches
 * other devices via a full-document merge instead of an incremental push.
 */
async function tryEnqueue(mutation: Mutation): Promise<void> {
  try {
    await enqueue(mutation);
  } catch (err) {
    console.warn('[store] could not enqueue mutation; local write is still safe', err);
  }
}

export interface AppState {
  /** False until `hydrate()` has read IndexedDB. The UI must not render progress-dependent screens before this flips. */
  readonly hydrated: boolean;
  readonly settings: Settings;
  readonly progress: ProgressMap;
  readonly sessions: readonly SessionResult[];
  readonly mocks: readonly MockResult[];
  readonly practiceDays: PracticeDays;
  readonly badges: Readonly<Record<string, number>>;
  readonly xp: number;

  hydrate(): Promise<void>;
  reloadFromDb(): Promise<void>;

  patchSettings(patch: Partial<Settings>): Promise<void>;
  switchState(state: StateCode): Promise<void>;

  answer(questionId: QuestionId, input: { correct: boolean; hintsUsed: number }, now?: number): Promise<QuestionProgress>;
  toggleFlag(questionId: QuestionId, now?: number): Promise<void>;
  setNote(questionId: QuestionId, note: string, now?: number): Promise<void>;

  finishSession(result: SessionResult): Promise<void>;
  finishMock(result: MockResult): Promise<void>;
  grantBadge(badge: string, now?: number): Promise<void>;
  gainXp(delta: number): Promise<void>;

  /** Clears progress for the currently-selected state only. Federal progress and other states survive. */
  resetCurrentState(): Promise<number>;
  resetEverything(): Promise<ResetAllOutcome>;
}

/**
 * What happened to the *cloud* copy during `resetEverything()`. The local wipe
 * is unconditional and has already succeeded by the time this is returned.
 *
 *  - `skipped`  — there was no cloud copy to erase: sync is unconfigured, or
 *                 nobody is signed in. Nothing to tell the user.
 *  - `cleared`  — the cloud copy was overwritten and the server acknowledged it.
 *  - `failed`   — the cloud copy could not be reached. The UI MUST say so: the
 *                 user asked for their data to be destroyed and a copy of it may
 *                 still exist. Silently reporting success here would be a lie.
 */
export type ResetCloudOutcome = 'skipped' | 'cleared' | 'failed';

export interface ResetAllOutcome {
  readonly cloud: ResetCloudOutcome;
}

/**
 * Pre-hydration defaults. `state: null` and `onboarded: false` are what route
 * guards read to send a first-run user into the wizard, so they must be the
 * initial values rather than an optimistic guess.
 */
const INITIAL_SETTINGS: Settings = {
  state: null,
  uiLocale: 'en',
  translation: 'off',
  alwaysShowTranslation: false,
  mockTranslations: false,
  recallFirst: true,
  tts: true,
  ttsAutoplay: false,
  theme: 'system',
  onboarded: false,
  updatedAt: 0,
};

export const useAppStore = create<AppState>((set, get) => ({
  hydrated: false,
  settings: INITIAL_SETTINGS,
  progress: {},
  sessions: [],
  mocks: [],
  practiceDays: {},
  badges: {},
  xp: 0,

  async hydrate() {
    if (get().hydrated) return;
    await get().reloadFromDb();
  },

  async reloadFromDb() {
    try {
      const doc = await loadProgressDoc();
      set({
        hydrated: true,
        settings: doc.settings,
        progress: doc.progress,
        sessions: doc.sessions,
        mocks: doc.mocks,
        practiceDays: doc.practiceDays,
        badges: doc.badges,
        xp: doc.xp,
      });
    } catch (err) {
      // A browser with IndexedDB blocked (private mode, hostile settings) must
      // still get a usable app rather than an infinite loading spinner. We mark
      // ourselves hydrated with in-memory defaults; nothing will persist, but
      // the user can still study.
      console.error('[store] could not load from IndexedDB; continuing in memory only', err);
      set({ hydrated: true });
    }
  },

  async patchSettings(patch) {
    const next = await saveSettings(patch);
    set({ settings: next });
    await tryEnqueue({ kind: 'settings', id: mutationId(), at: next.updatedAt, value: next });
  },

  /**
   * Switching Bundesland is a settings change and nothing more. We deliberately
   * do NOT delete or migrate progress: the previous state's rows stay on disk,
   * so switching back restores them exactly. Federal progress is shared by all
   * 16 states because it is keyed by question id.
   */
  async switchState(state) {
    await get().patchSettings({ state });
  },

  async answer(questionId, input, now = Date.now()) {
    const prev = get().progress[questionId];
    const next = recordAnswer(prev, { correct: input.correct, hintsUsed: input.hintsUsed, now });

    await putQuestionProgress(questionId, next);
    set((s) => ({ progress: { ...s.progress, [questionId]: next } }));

    // Answering is what counts as practising today — record it here rather than
    // at session end so an abandoned session still keeps the streak honest.
    const day = dayKey(now);
    if (!get().practiceDays[day]) {
      await markPracticeDay(day, now);
      set((s) => ({ practiceDays: { ...s.practiceDays, [day]: true } }));
      await tryEnqueue({ kind: 'practiceDay', id: mutationId(), at: now, day });
    }

    await tryEnqueue({ kind: 'progress', id: mutationId(), at: now, questionId, value: next });
    return next;
  },

  async toggleFlag(questionId, now = Date.now()) {
    const prev = get().progress[questionId];
    const next = setFlag(prev, !(prev?.flagged ?? false), now);
    await putQuestionProgress(questionId, next);
    set((s) => ({ progress: { ...s.progress, [questionId]: next } }));
    await tryEnqueue({ kind: 'progress', id: mutationId(), at: now, questionId, value: next });
  },

  async setNote(questionId, note, now = Date.now()) {
    const prev = get().progress[questionId];
    const next = applyNote(prev, note, now);
    await putQuestionProgress(questionId, next);
    set((s) => ({ progress: { ...s.progress, [questionId]: next } }));
    await tryEnqueue({ kind: 'progress', id: mutationId(), at: now, questionId, value: next });
  },

  async finishSession(result) {
    await appendSession(result);
    set((s) => ({ sessions: [...s.sessions, result] }));
    await tryEnqueue({ kind: 'session', id: mutationId(), at: result.finishedAt, value: result });
  },

  async finishMock(result) {
    await appendMock(result);
    set((s) => ({ mocks: [...s.mocks, result] }));
    await tryEnqueue({ kind: 'mock', id: mutationId(), at: result.finishedAt, value: result });
  },

  async grantBadge(badge, now = Date.now()) {
    // `awardBadge` is first-write-wins on disk and returns the stored time, so
    // re-earning a badge never moves its date.
    const earnedAt = await dbAwardBadge(badge, now);
    set((s) => ({ badges: { ...s.badges, [badge]: earnedAt } }));
    await tryEnqueue({ kind: 'badge', id: mutationId(), at: now, badge, earnedAt });
  },

  async gainXp(delta) {
    const total = await dbAddXp(delta);
    set({ xp: total });
    await tryEnqueue({ kind: 'xp', id: mutationId(), at: Date.now(), value: total });
  },

  async resetCurrentState() {
    const state = get().settings.state;
    if (state === null) return 0;
    const removed = await dbResetState(state);
    await get().reloadFromDb();
    return removed;
  },

  async resetEverything() {
    // The local wipe is the part the user actually asked for, so it happens
    // first and unconditionally. Everything after this point is about the cloud
    // copy and must not be able to undo it.
    await dbResetAll();
    await get().reloadFromDb();
    const cloud = await clearCloudCopy();
    return { cloud };
  },
}));

/**
 * Best-effort erase of the cloud copy, called only from `resetEverything()`.
 *
 * This function NEVER throws. `DangerZone` invokes the reset as
 * `void confirmResetAll()` inside a `try/finally` with no `catch`, so a
 * rejection would surface as an unhandled promise rejection *and* swallow the
 * success message. The outcome is data, not an exception.
 *
 * Both imports are dynamic on purpose: the Firebase SDK is ~200 KB and must stay
 * out of the app shell for the overwhelmingly common case of a user who never
 * configures sync.
 */
async function clearCloudCopy(): Promise<ResetCloudOutcome> {
  try {
    const { isFirebaseConfigured } = await import('@/lib/firebase');
    // Placeholder config -> the noop adapter -> there is no cloud copy at all.
    if (!isFirebaseConfigured()) return 'skipped';

    const sync = await import('@/lib/sync/firestore');
    try {
      // `loadProgressDoc()` now returns the *cleared* document, which is exactly
      // what we want the remote to become: local and remote end byte-identical.
      const cleared = await loadProgressDoc();
      await sync.resetRemoteProgress(sync.createFirestoreAdapter(), cleared);
      return 'cleared';
    } catch (err) {
      // `signed-out` is not a failure worth alarming anyone about: if nobody ever
      // signed in on this device there is no cloud document to erase. Every other
      // code means a copy of the data the user asked us to destroy may still
      // exist, and we must say so rather than quietly print "Progress reset."
      if (sync.isSyncError(err) && err.code === 'signed-out') return 'skipped';
      throw err;
    }
  } catch (err) {
    console.error('[store] local data was cleared but the cloud copy was not', err);
    return 'failed';
  }
}

/* ───────────────────────────── selectors ─────────────────────────────── */
// Narrow hooks so components re-render on the slice they actually use rather
// than on every store write. Prefer these over `useAppStore(s => ...)` inline.

export const useHydrated = (): boolean => useAppStore((s) => s.hydrated);
export const useSettings = (): Settings => useAppStore((s) => s.settings);
export const useActiveState = (): StateCode | null => useAppStore((s) => s.settings.state);
export const useProgress = (): ProgressMap => useAppStore((s) => s.progress);
export const useXp = (): number => useAppStore((s) => s.xp);
export const useBadges = (): Readonly<Record<string, number>> => useAppStore((s) => s.badges);
export const useSessions = (): readonly SessionResult[] => useAppStore((s) => s.sessions);
export const useMocks = (): readonly MockResult[] => useAppStore((s) => s.mocks);
export const usePracticeDays = (): PracticeDays => useAppStore((s) => s.practiceDays);

/** Progress for one question, or `undefined` if never answered. */
export const useQuestionProgress = (id: QuestionId): QuestionProgress | undefined =>
  useAppStore((s) => s.progress[id]);

/**
 * True when the first-run wizard should take over. Checked by the route guard
 * rather than by individual screens, so there is one definition of "new user".
 */
export const useNeedsOnboarding = (): boolean =>
  useAppStore((s) => s.hydrated && (!s.settings.onboarded || s.settings.state === null));
