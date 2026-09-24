/**
 * The canonical two-device merge for the whole progress document.
 *
 * This is the highest-risk module in the app: if it is wrong, users silently
 * lose study progress they earned. The governing rule, from which every
 * field-level decision below is derived:
 *
 *   **A merge must never lose progress a user actually earned.**
 *   When in doubt, keep the more-studied value.
 *
 * It is the implementation behind the {@link MergeFn} seam declared in
 * `src/lib/transfer.ts`, so it drops straight into both call sites:
 *
 * ```ts
 * await importProgress(text, mergeDocs);      // manual file import
 * const merged = mergeDocs(remote, local);    // Firestore read-merge-write
 * ```
 *
 * ## Algebraic properties (all tested in `merge.test.ts`)
 *
 * - **Pure & deterministic.** No `Date.now()`, no `Math.random()`, no I/O. The
 *   merged document is a function of its two inputs and nothing else.
 * - **Never mutates either input.** Inputs are deeply `readonly`; untouched
 *   sub-objects are shared by reference rather than cloned (cheap, and safe
 *   because nothing in the app mutates a `ProgressDoc` in place).
 * - **Commutative.** `merge(a, b)` deep-equals `merge(b, a)` on *every* field.
 *   This is not free: last-write-wins is only commutative when the two
 *   `updatedAt` stamps differ. Wherever they are exactly equal and the values
 *   disagree, a deterministic tie-break over the *values themselves* is used,
 *   so the result never depends on which device happened to be "local".
 * - **Idempotent / monotonic.** `merge(a, merge(a, b))` equals `merge(a, b)`.
 *   Every field rule is a "max" over some total order (or a least-upper-bound
 *   over a lattice: max, min, union, OR), which makes the whole document merge
 *   a join — associative, commutative and idempotent by construction. That is
 *   what lets the same mutation be pushed, pulled and re-merged any number of
 *   times without drift.
 *
 * ## Why "max" on counters and not "sum"
 *
 * `seen`/`correct`/`wrong`/`hintsUsed` are absolute per-question counters, not
 * deltas. Summing would double-count the same answer whenever a device syncs
 * twice (and syncing twice is the normal case: push, then a snapshot echo back
 * from Firestore). `max` is the honest lower bound: it can only ever discard a
 * duplicate increment, never real work.
 */

import type {
  AnswerRecord,
  MockResult,
  ProgressDoc,
  QuestionId,
  QuestionProgress,
  SessionResult,
  Settings,
} from '@/types';
// Type-only: guarantees this module really satisfies the seam in transfer.ts
// without creating a runtime import cycle (transfer.ts imports the db layer).
import type { MergeFn } from '@/lib/transfer';

/* ─────────────────────────── generic tie-breaks ─────────────────────────── */

/**
 * Deterministic, key-sorted JSON. Used *only* as the final tie-break between
 * two values that are semantically peers (same `updatedAt`, or two copies of an
 * immutable record with the same id). Sorting the keys matters: a document that
 * round-tripped through Firestore or JSON may come back with a different key
 * order, and the tie-break must not depend on that.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : 'null';
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`).join(',')}}`;
}

/**
 * Last-write-wins over a *state* field, made commutative.
 *
 * `ease`, `dueAt`, `note` and `flagged` are states, not counters: maxing them
 * would be actively wrong (see the comments at each call site). So the side
 * with the later `updatedAt` wins. Where the two stamps are *identical* — two
 * devices wrote the same question in the same millisecond, or (far more likely)
 * both sides carry a stamp of 0 because the field was never written — LWW has
 * no answer, and naively keeping `local` would make the merge depend on
 * argument order. `tieBreak` resolves those cases from the values alone, so
 * `merge(a, b)` and `merge(b, a)` still agree.
 */
function pickLatest<T>(
  localAt: number,
  local: T,
  incomingAt: number,
  incoming: T,
  tieBreak: (a: T, b: T) => T,
): T {
  if (localAt > incomingAt) return local;
  if (incomingAt > localAt) return incoming;
  return tieBreak(local, incoming);
}

/**
 * Tie-break for `note`: keep the richer text.
 *
 * Ordered by (length, then lexicographic) so it is a max over a total order and
 * therefore commutative and idempotent. Longer wins because a note is typed by
 * hand and losing characters the user typed is the worst outcome; the empty
 * string has length 0, so a real note always beats "no note".
 */
function richerNote(a: string, b: string): string {
  if (a === b) return a;
  if (a.length !== b.length) return (a.length > b.length ? a : b);
  return a > b ? a : b;
}

/**
 * Tie-break for `flagged`: a raised flag wins.
 *
 * See the long note on flag semantics in {@link mergeQuestionProgress}.
 */
function flagUnion(a: boolean, b: boolean): boolean {
  return a || b;
}

/* ───────────────────────────── per question ─────────────────────────────── */

/**
 * Merge one question's progress. Exported so tests and the UI can reason about
 * a single question without building two whole documents.
 *
 * ### Counters — `max`
 * `seen`, `correct`, `wrong`, `hintsUsed`, `consecutiveCorrect` and `lastSeen`
 * are all monotonic facts about study that happened. `consecutiveCorrect` in
 * particular is maxed rather than reset: the user *did* achieve that streak on
 * some device, and a merge is not evidence that they broke it.
 *
 * ### `ease` / `dueAt` — last-write-wins
 * These are scheduler *state*. Maxing `dueAt` would push a question that is due
 * now into the future (progress silently lost — the user never sees the card
 * again this week); maxing `ease` would fake mastery and stretch the interval.
 * So the later write wins. On an exact `updatedAt` tie we take the **minimum**
 * of the two: the earlier due date and the lower ease both mean *more* review,
 * which is the conservative direction and keeps the merge commutative.
 *
 * ### `note` — last-write-wins, richer text on a tie
 *
 * ### `flagged` — last-write-wins, `true` on a tie
 * Two rules were possible and they trade off against each other:
 *
 * 1. **Pure union (`local || incoming`).** A flag raised on either device is
 *    intentional, so sync can never silently unflag. The cost: un-flagging
 *    becomes *non-convergent*. While both copies disagree, every merge
 *    re-asserts the flag, and because the Firestore push path is a
 *    read-merge-write against the remote copy, a cleared flag would be
 *    resurrected on the next sync — for ever. "I cannot unflag anything once I
 *    sign in" is a permanent, user-visible defect.
 * 2. **Last-write-wins with `true` winning an exact tie** — what is implemented
 *    here. Clearing a flag is a local action that wins as soon as its
 *    `updatedAt` is the later one, which it always is on the device that
 *    cleared it (clearing a flag stamps `updatedAt`), so un-flagging converges.
 *    Truly concurrent writes (identical `updatedAt`) still resolve to
 *    `flagged: true`, so the "never silently unflag" intent is preserved in
 *    exactly the case where LWW has no opinion.
 *
 * Residual risk, stated plainly: if device A raises a flag at t=5 and device B
 * writes the *same* question at t=10 without the flag, the flag is dropped. We
 * accept that narrow loss (one tap to restore, and B's user was looking at that
 * question more recently) in exchange for un-flagging working at all. Flags are
 * navigation aids, not earned progress, so this does not violate the governing
 * rule. `QuestionProgress` has no per-field timestamps and the type contract is
 * frozen, so a proper per-field clock is not available.
 */
export function mergeQuestionProgress(
  local: QuestionProgress,
  incoming: QuestionProgress,
): QuestionProgress {
  const localAt = local.updatedAt;
  const incomingAt = incoming.updatedAt;
  return {
    seen: Math.max(local.seen, incoming.seen),
    correct: Math.max(local.correct, incoming.correct),
    wrong: Math.max(local.wrong, incoming.wrong),
    consecutiveCorrect: Math.max(local.consecutiveCorrect, incoming.consecutiveCorrect),
    hintsUsed: Math.max(local.hintsUsed, incoming.hintsUsed),
    lastSeen: Math.max(local.lastSeen, incoming.lastSeen),
    ease: pickLatest(localAt, local.ease, incomingAt, incoming.ease, Math.min),
    dueAt: pickLatest(localAt, local.dueAt, incomingAt, incoming.dueAt, Math.min),
    flagged: pickLatest(localAt, local.flagged, incomingAt, incoming.flagged, flagUnion),
    note: pickLatest(localAt, local.note, incomingAt, incoming.note, richerNote),
    // The merged record is as fresh as the freshest input: anything older than
    // this has already been folded in, so a later re-merge is a no-op.
    updatedAt: Math.max(localAt, incomingAt),
  };
}

/**
 * Union of two progress maps.
 *
 * **A question present on only one side is kept verbatim.** This is the single
 * most important property in the file: it is what makes "two devices studied
 * different questions offline" safe, and it is why the map is a union rather
 * than a pick.
 */
function mergeProgress(
  local: Readonly<Record<QuestionId, QuestionProgress>>,
  incoming: Readonly<Record<QuestionId, QuestionProgress>>,
): Record<QuestionId, QuestionProgress> {
  const out: Record<QuestionId, QuestionProgress> = { ...local };
  for (const [id, entry] of Object.entries(incoming)) {
    const mine = out[id];
    out[id] = mine === undefined ? entry : mergeQuestionProgress(mine, entry);
  }
  return out;
}

/* ─────────────────────────── sessions and mocks ─────────────────────────── */

/** The shape both `SessionResult` and `MockResult` share for merge purposes. */
interface HistoryRecord {
  readonly id: string;
  readonly finishedAt: number;
  readonly answers: readonly AnswerRecord[];
}

/**
 * Two copies of the same completed session/mock. These are immutable once
 * written, so in practice the copies are identical and either will do — but
 * "in practice" is not determinism. Copies *can* differ when one side was
 * written by an older build (e.g. a legacy row whose `state` had to be
 * inferred, or whose `answers` were dropped). Prefer the richer copy (more
 * answers), then break any remaining tie on canonical JSON so the choice is a
 * max over a total order and cannot depend on argument order.
 */
function pickHistoryRecord<T extends HistoryRecord>(a: T, b: T): T {
  if (a === b) return a;
  if (a.answers.length !== b.answers.length) return (a.answers.length > b.answers.length ? a : b);
  return canonicalJson(a) >= canonicalJson(b) ? a : b;
}

/**
 * Union by `id`, never truncated, sorted by `finishedAt` with `id` as a stable
 * tie-break. Because ids are unique the sort key is unique, so the order is
 * fully deterministic and identical for `merge(a, b)` and `merge(b, a)`.
 */
function unionHistory<T extends HistoryRecord>(local: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of local) {
    const existing = byId.get(row.id);
    byId.set(row.id, existing === undefined ? row : pickHistoryRecord(existing, row));
  }
  for (const row of incoming) {
    const existing = byId.get(row.id);
    byId.set(row.id, existing === undefined ? row : pickHistoryRecord(existing, row));
  }
  return [...byId.values()].sort((a, b) => {
    if (a.finishedAt !== b.finishedAt) return a.finishedAt - b.finishedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/* ──────────────────────────────── settings ──────────────────────────────── */

/**
 * Carry forward the two settings fields that must never regress, whatever the
 * timestamps say:
 *
 * - **`state`** is `StateCode | null`, and `null` means "onboarding has not
 *   happened yet". A `null` from a device that never finished onboarding must
 *   never overwrite a real state — that would throw a synced user straight back
 *   into the first-run wizard and (worse) change which state's questions they
 *   are studying. Progress is namespaced per state and never deleted, so
 *   keeping a state is always safe.
 * - **`onboarded`** is a one-way milestone for the same reason: onboarding
 *   cannot un-happen, so it is OR'd rather than overwritten.
 *
 * Everything else is taken wholesale from the winning record (see
 * {@link mergeSettings}).
 */
function carryForward(winner: Settings, loser: Settings): Settings {
  const state = winner.state ?? loser.state;
  const onboarded = winner.onboarded || loser.onboarded;
  if (state === winner.state && onboarded === winner.onboarded) return winner;
  return { ...winner, state, onboarded };
}

/**
 * Settings are merged as a **coherent unit**, not field by field: mixing
 * fields from two devices can produce a combination the user never chose (e.g.
 * `translation: 'off'` together with `alwaysShowTranslation: true`). So the
 * record with the later `settings.updatedAt` wins wholesale, then
 * {@link carryForward} repairs the two non-regressing fields.
 *
 * On an exact `updatedAt` tie both candidates are repaired *first* and then
 * compared by canonical JSON. Repairing before comparing is what makes the
 * result idempotent: the winner already carries the union of `state`/
 * `onboarded`, so re-merging it against either input reproduces it exactly.
 */
function mergeSettings(local: Settings, incoming: Settings): Settings {
  if (local.updatedAt > incoming.updatedAt) return carryForward(local, incoming);
  if (incoming.updatedAt > local.updatedAt) return carryForward(incoming, local);
  const fromLocal = carryForward(local, incoming);
  const fromIncoming = carryForward(incoming, local);
  return canonicalJson(fromLocal) >= canonicalJson(fromIncoming) ? fromLocal : fromIncoming;
}

/* ─────────────────────────── badges, days, xp ───────────────────────────── */

/**
 * Union of earned badges, keeping the **earliest** earn time. A badge is earned
 * once; if two devices recorded different moments, the earlier one is the truth
 * (the later is just when the other device noticed). `min` also makes this
 * idempotent, where a "latest wins" rule would let the timestamp drift forward
 * on every sync.
 */
function mergeBadges(
  local: Readonly<Record<string, number>>,
  incoming: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = { ...local };
  for (const [badge, at] of Object.entries(incoming)) {
    const mine = out[badge];
    out[badge] = mine === undefined ? at : Math.min(mine, at);
  }
  return out;
}

/* ────────────────────────────── the document ────────────────────────────── */

/**
 * Merge two whole progress documents.
 *
 * Signature and behaviour match {@link MergeFn} exactly, so this is a drop-in
 * for `importProgress(text, mergeDocs)` and for the Firestore adapter's
 * read-merge-write.
 *
 * Rule summary (details and rationale at each helper):
 * | field           | rule                                             |
 * |-----------------|--------------------------------------------------|
 * | `schemaVersion` | `max`                                            |
 * | `settings`      | whole record with the later `updatedAt`; `state` never nulled, `onboarded` OR'd |
 * | `progress`      | key union; per question see `mergeQuestionProgress` |
 * | `sessions`      | union by `id`, sorted by (`finishedAt`, `id`)     |
 * | `mocks`         | union by `id`, sorted by (`finishedAt`, `id`)     |
 * | `practiceDays`  | key union                                        |
 * | `badges`        | key union, earliest earn time                    |
 * | `xp`            | `max`                                            |
 * | `updatedAt`     | `max`                                            |
 */
export const mergeDocs: MergeFn = (local: ProgressDoc, incoming: ProgressDoc): ProgressDoc => ({
  // Never downgrade the recorded schema version: the merged document contains
  // everything both sides had, so it is at least as new as the newer input.
  schemaVersion: Math.max(local.schemaVersion, incoming.schemaVersion),
  settings: mergeSettings(local.settings, incoming.settings),
  progress: mergeProgress(local.progress, incoming.progress),
  sessions: unionHistory<SessionResult>(local.sessions, incoming.sessions),
  mocks: unionHistory<MockResult>(local.mocks, incoming.mocks),
  // A practised day is a fact; the value is always `true`, so a key union is
  // the whole rule. Streaks are derived from this map, so losing a key would
  // silently break a streak the user earned.
  practiceDays: { ...local.practiceDays, ...incoming.practiceDays },
  badges: mergeBadges(local.badges, incoming.badges),
  // XP is an absolute running total, so `max` (never sum — see the header note
  // on double-counting).
  xp: Math.max(local.xp, incoming.xp),
  updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
});
