/**
 * The Firestore sync adapter — optional cloud backup of the progress document.
 *
 * Three rules shape everything in this file:
 *
 * 1. **Sync is an optional upgrade, never a dependency.** Firebase is
 *    unconfigured by default (`src/lib/firebase.ts` ships placeholders), and in
 *    that state every method here behaves exactly like `./noop.ts`: it resolves,
 *    it does nothing, and it cannot throw, hang or block the UI. A user who
 *    never touches sign-in must never be able to tell this file exists.
 * 2. **Never clobber another device.** The remote document is read, merged with
 *    `mergeDocs`, and only then written — inside a Firestore transaction, so a
 *    concurrent write from another device is retried rather than lost. If the
 *    remote document cannot be *understood*, the write is refused instead of
 *    overwriting it.
 * 3. **Nothing from the network is trusted.** The remote document may have been
 *    written by an older build, corrupted, or hand-edited in the console. It is
 *    validated by {@link parseRemoteProgressDoc} before it ever reaches the
 *    merge; anything unreadable is treated as "no document".
 *
 * There is exactly one deliberate exception to rule 2: {@link RemoteResettable}'s
 * `resetRemote`, which overwrites the remote document without merging. It exists
 * because "delete all my data" is explicit user intent, and a merge would
 * resurrect what the user just asked to be gone — see the method for details.
 *
 * ## Errors
 *
 * Failures that the user must be told about are thrown as {@link SyncError} with
 * a machine-readable {@link SyncErrorCode}; everything else is reported through
 * `status()` and the console. Nothing that is merely "not configured" throws.
 *
 * ## Bundle size
 *
 * Every `firebase/*` import here is **lazy** — either behind `getFirebase()` or
 * an inline `await import(...)`. The only static imports are `import type`,
 * which TypeScript erases. `firebase/app` + `firebase/auth` +
 * `firebase/firestore` are ~200KB, and only users who actually sign in should
 * pay for them. Do not add a top-level value import from `firebase/...` to this
 * file.
 *
 * ## Document layout
 *
 * One document per user: `users/{uid}`, holding the entire `ProgressDoc`. One
 * document means a pull is atomic (no torn read across collections) and the
 * merge always operates on whole, self-consistent documents. See
 * `firestore.rules` for the matching least-privilege access rules — those are
 * **not** deployed automatically.
 */

import type { Auth, User } from 'firebase/auth';
import type { Unsubscribe as FirestoreUnsubscribe } from 'firebase/firestore';

import type {
  MockResult,
  Mutation,
  ProgressDoc,
  QuestionId,
  QuestionProgress,
  SessionResult,
  Settings,
  SyncAccount,
  SyncAdapter,
  SyncStatus,
  Unsubscribe,
} from '@/types';
import { getFirebase, isFirebaseConfigured, type FirebaseHandle } from '@/lib/firebase';
import {
  coerceMockResult,
  coerceQuestionProgress,
  coerceSessionResult,
  coerceSettings,
  defaultSettings,
  FALLBACK_STATE,
  isRecord,
  isSafeMapKey,
  MAX_XP,
  timestampCeiling,
} from '@/lib/db/schema';
import { DB_VERSION } from '@/lib/db/migrations';
import { mergeDocs, mergeQuestionProgress } from './merge';

export const FIRESTORE_ADAPTER_NAME = 'firestore';

/** Collection holding one document per signed-in user. */
export const USERS_COLLECTION = 'users';

/** `users/{uid}` — kept here so the adapter and `firestore.rules` cannot drift. */
export function userDocPath(uid: string): string {
  return `${USERS_COLLECTION}/${uid}`;
}

/**
 * Oldest remote schema version this build is willing to read. v1 predates the
 * spaced-repetition fields, but `coerceQuestionProgress` backfills them exactly
 * as the IndexedDB migration does, so v1 documents are still safe to merge.
 * Anything below this (0, negative, fractional) is not a version we ever wrote.
 */
export const MIN_REMOTE_SCHEMA_VERSION = 1;

function warn(message: string, error?: unknown): void {
  // Console-only, like the db layer: sync problems are surfaced through
  // `status()`, never as exceptions the UI has to catch.
  if (error === undefined) console.warn(`[sync/firestore] ${message}`);
  else console.warn(`[sync/firestore] ${message}`, error);
}

/* ──────────────────────────── typed errors ──────────────────────────── */

/**
 * Why a sync operation refused or failed, in a form the UI can branch on
 * without string-matching a message.
 *
 * - `'signed-out'` — the adapter is configured but nobody is signed in, so the
 *   operation cannot touch the cloud copy. Recoverable: sign in and retry.
 * - `'too-large'` — the document exceeds {@link MAX_REMOTE_DOC_BYTES}. Not
 *   recoverable by retrying; the user has to export and prune.
 * - `'remote-newer'` — the remote document was written by a newer build of the
 *   app. **This device must be updated**; pushing would silently drop fields it
 *   does not understand.
 * - `'remote-unreadable'` — a remote document exists but is not a readable
 *   `ProgressDoc`. Refused rather than overwritten: it may be the user's only
 *   copy.
 * - `'reset-failed'` — the local data was cleared but the cloud copy could not
 *   be cleared. The local wipe still stands (see {@link resetRemoteProgress}).
 */
export type SyncErrorCode =
  | 'signed-out'
  | 'too-large'
  | 'remote-newer'
  | 'remote-unreadable'
  | 'reset-failed'
  /** Account deletion did not complete. The account may still exist. */
  | 'delete-failed'
  /**
   * Deletion needs a fresh credential and the user dismissed the re-auth prompt.
   * Not a failure to apologise for — nothing was deleted and nothing is broken.
   */
  | 'reauth-cancelled';

/**
 * The single error type sync throws on purpose.
 *
 * Everything the UI needs to catch is one `instanceof SyncError` away, and
 * {@link SyncError.code} says which message to render. Unexpected failures
 * (network, permissions) are *not* wrapped in this: they flow through
 * `status()` instead, because the UI already renders `'offline'` and `'error'`.
 * The one exception is {@link resetRemoteProgress}, which normalises everything
 * to `'reset-failed'` so a "delete my data" failure can never be silent.
 */
export class SyncError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(`[sync/firestore] ${message}`, options);
    this.name = 'SyncError';
    this.code = code;
  }
}

/** Narrowing helper, so callers never have to import the class to check. */
export function isSyncError(value: unknown): value is SyncError {
  return value instanceof SyncError;
}

/* ────────────────────────── runtime validation ──────────────────────── */

/**
 * Validate an arbitrary value read from Firestore and turn it into a
 * `ProgressDoc`, or return `null` if it is not one.
 *
 * Strict where a mistake would be silent, tolerant where the codebase already
 * knows how to recover:
 *
 * - **Rejected outright** (`null`): non-objects, arrays, `null`, a missing or
 *   wrongly-typed `settings`/`progress`/`sessions`/`mocks`/`practiceDays`/
 *   `badges` container, or a `schemaVersion` that is not an integer
 *   `>= MIN_REMOTE_SCHEMA_VERSION`. These mean "this is not our document", and
 *   guessing would risk writing a malformed doc back over a good one.
 * - **Coerced** (same rules as reading from IndexedDB): individual entries
 *   inside those containers, plus `xp` and `updatedAt`, which default to `0`.
 *   A single corrupt question entry is dropped rather than failing the whole
 *   document — the alternative would block sync entirely for that user.
 *
 * Note `schemaVersion` *newer* than `DB_VERSION` is accepted for reading (we
 * keep every field this build understands), but {@link createFirestoreAdapter}
 * refuses to *write* over such a document — see `push`.
 */
export function parseRemoteProgressDoc(value: unknown): ProgressDoc | null {
  if (!isRecord(value)) return null;

  const rawSchemaVersion = value['schemaVersion'];
  if (
    typeof rawSchemaVersion !== 'number' ||
    !Number.isInteger(rawSchemaVersion) ||
    rawSchemaVersion < MIN_REMOTE_SCHEMA_VERSION
  ) {
    return null;
  }

  const rawSettings = value['settings'];
  const rawProgress = value['progress'];
  const rawSessions = value['sessions'];
  const rawMocks = value['mocks'];
  const rawPracticeDays = value['practiceDays'];
  const rawBadges = value['badges'];
  if (!isRecord(rawSettings)) return null;
  if (!isRecord(rawProgress)) return null;
  if (!Array.isArray(rawSessions)) return null;
  if (!Array.isArray(rawMocks)) return null;
  if (!isRecord(rawPracticeDays)) return null;
  if (!isRecord(rawBadges)) return null;

  const settings = coerceSettings(rawSettings);
  const fallbackState = settings.state ?? FALLBACK_STATE;

  const progress: Record<QuestionId, QuestionProgress> = {};
  for (const [id, entry] of Object.entries(rawProgress)) {
    // `isSafeMapKey` subsumes the old `id !== ''` check and additionally rejects
    // `constructor` and friends — see its docblock in `db/schema.ts`.
    if (!isSafeMapKey(id)) continue;
    const coerced = coerceQuestionProgress(entry);
    if (coerced !== null) progress[id] = coerced;
  }

  const sessions: SessionResult[] = [];
  for (const entry of rawSessions) {
    const coerced = coerceSessionResult(entry, fallbackState);
    if (coerced !== null) sessions.push(coerced);
  }

  const mocks: MockResult[] = [];
  for (const entry of rawMocks) {
    const coerced = coerceMockResult(entry, fallbackState);
    if (coerced !== null) mocks.push(coerced);
  }

  const practiceDays: Record<string, true> = {};
  for (const [day, flag] of Object.entries(rawPracticeDays)) {
    if (flag === true && isSafeMapKey(day)) practiceDays[day] = true;
  }

  const ceiling = timestampCeiling();

  const badges: Record<string, number> = {};
  for (const [badge, at] of Object.entries(rawBadges)) {
    if (!isSafeMapKey(badge)) continue;
    if (typeof at === 'number' && Number.isFinite(at) && at >= 0) {
      badges[badge] = Math.min(at, ceiling);
    }
  }

  const rawXp = value['xp'];
  const rawUpdatedAt = value['updatedAt'];

  return {
    schemaVersion: rawSchemaVersion,
    settings,
    progress,
    sessions,
    mocks,
    practiceDays,
    badges,
    // Both are merged with `Math.max`, so an unbounded remote value would pin
    // them on every device for ever. The rules cannot express this bound (they
    // have no clock arithmetic on client values), so the client enforces it.
    xp:
      typeof rawXp === 'number' && Number.isFinite(rawXp) && rawXp > 0
        ? Math.min(rawXp, MAX_XP)
        : 0,
    updatedAt:
      typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) && rawUpdatedAt > 0
        ? Math.min(rawUpdatedAt, ceiling)
        : 0,
  };
}

/**
 * Firestore's hard per-document ceiling is 1 MiB. Refuse a little below it so a
 * push fails loudly (mutations stay in the outbox) instead of the write being
 * rejected mid-transaction or, worse, silently truncated somewhere upstream.
 *
 * **Known limitation.** One document per user is what makes a pull atomic, but it
 * inherits that ceiling, and there is no document-splitting strategy. Sessions
 * are the growth driver: each one carries a full `answers` array. A very heavy
 * user (years of daily study) could eventually be unable to push at all. When
 * that happens the push throws {@link SyncError} with code `'too-large'` — the
 * UI should tell the user to export a backup, because retrying cannot help.
 */
export const MAX_REMOTE_DOC_BYTES = 900_000;

/**
 * Convert to plain JSON data for Firestore. The round-trip strips `undefined`
 * (Firestore rejects it, and `exactOptionalPropertyTypes` means optional fields
 * like `SessionResult.levelId` are simply absent) and guarantees only plain
 * objects, arrays, numbers, strings and booleans are sent.
 *
 * Exported so the size guard is testable without a Firebase project.
 *
 * @throws {SyncError} `'too-large'` when the document exceeds the ceiling.
 */
export function toRemoteData(doc: ProgressDoc): Record<string, unknown> {
  const json = JSON.stringify(doc);
  if (json.length > MAX_REMOTE_DOC_BYTES) {
    throw new SyncError(
      'too-large',
      `progress document is ${json.length} bytes, over the ${MAX_REMOTE_DOC_BYTES} byte sync limit`,
    );
  }
  const plain: unknown = JSON.parse(json);
  // Defensive and unreachable: a `ProgressDoc` is always a plain object. Left as
  // a plain Error because there is no user-actionable code for "impossible".
  if (!isRecord(plain)) throw new Error('[sync/firestore] document did not serialise to an object');
  return plain;
}

/**
 * Guard run against the remote document *before* a push overwrites it. Pure, so
 * the two refusals that protect user data are testable without a live project.
 *
 * @param remote the result of {@link parseRemoteProgressDoc}, or `null`.
 * @param existed whether a document was actually present in the snapshot — a
 *   `null` parse for a document that exists means "unreadable", while a `null`
 *   parse for a document that does not exist simply means "first write".
 * @throws {SyncError} `'remote-unreadable'` or `'remote-newer'`.
 */
export function assertRemoteWritable(remote: ProgressDoc | null, existed: boolean): void {
  if (existed && remote === null) {
    // Refuse rather than overwrite: an unreadable document may still hold a
    // user's only copy of their progress.
    throw new SyncError(
      'remote-unreadable',
      'the cloud copy is not a readable progress document; refusing to overwrite it',
    );
  }
  if (remote !== null && remote.schemaVersion > DB_VERSION) {
    // Written by a newer build. Merging would silently drop fields this build
    // does not know about, so stall — loudly. Silently not syncing is the worst
    // failure mode available: the user would believe their progress is backed up
    // when it is not.
    throw new SyncError(
      'remote-newer',
      `the cloud copy was written by a newer version of the app (schema ${remote.schemaVersion}, this build reads ${DB_VERSION}). Update the app on this device to keep syncing; progress on this device is safe in the meantime`,
    );
  }
}

/* ─────────────────────────── mutations → doc ────────────────────────── */

export interface Overlay {
  /** A `ProgressDoc` containing only what the queued mutations changed. */
  readonly doc: ProgressDoc;
  /** Whether a settings mutation was present (see {@link applyMutations}). */
  readonly hasSettings: boolean;
}

/**
 * Fold the outbox into a sparse `ProgressDoc` that can be merged into the
 * remote one.
 *
 * **Invariant every producer of `Mutation` must respect:** payloads are
 * *absolute* snapshots (a whole `QuestionProgress`, the total `xp`), never
 * deltas. That is the only reason they are safe to replay through a `max`-based
 * merge any number of times. A delta (`xp: +10`) would be double-counted on
 * every retry, echo and re-merge. Do not "optimise" the outbox into deltas.
 *
 * **Two clocks, deliberately.** `mutation.at` is when the mutation was *queued*
 * and is used only for the document-level `updatedAt`; every merge decision uses
 * the timestamp *inside* the payload (`value.updatedAt`), because that is what
 * the other device compares against. They are normally within milliseconds of
 * each other, but if a producer ever stamps them inconsistently, last-write-wins
 * fields (settings, `ease`, `dueAt`, `note`, `flagged`) would resolve against
 * the wrong clock. Stamp both from the same `now`.
 */
export function overlayFromMutations(mutations: readonly Mutation[]): Overlay {
  const progress: Record<QuestionId, QuestionProgress> = {};
  // Keyed by id, not appended: two mutations can carry the same completed
  // session (a retried local write), and with no remote document to merge
  // against, an array would ship the duplicate straight to Firestore and
  // double-count it in every statistic derived from it.
  const sessions = new Map<string, SessionResult>();
  const mocks = new Map<string, MockResult>();
  const practiceDays: Record<string, true> = {};
  const badges: Record<string, number> = {};
  let settings: Settings | null = null;
  let xp = 0;
  let updatedAt = 0;

  for (const mutation of mutations) {
    updatedAt = Math.max(updatedAt, mutation.at);
    switch (mutation.kind) {
      case 'progress': {
        // Skip ids that would collide with an `Object.prototype` member: the
        // lookup below would return a function instead of `undefined` and drive
        // it into `mergeQuestionProgress`, which throws. Because `push()` calls
        // this on every cycle, one such id in the outbox made every future push
        // throw for ever. Parsers reject these on ingress too; this is the layer
        // that keeps an already-poisoned local queue from being unrecoverable.
        if (!isSafeMapKey(mutation.questionId)) break;
        const existing = Object.prototype.hasOwnProperty.call(progress, mutation.questionId)
          ? progress[mutation.questionId]
          : undefined;
        progress[mutation.questionId] =
          existing === undefined ? mutation.value : mergeQuestionProgress(existing, mutation.value);
        break;
      }
      case 'settings':
        // Settings are a coherent unit: the most recently stamped queued record
        // wins outright rather than being blended.
        settings =
          settings === null || mutation.value.updatedAt >= settings.updatedAt
            ? mutation.value
            : settings;
        break;
      case 'session':
        sessions.set(mutation.value.id, mutation.value);
        break;
      case 'mock':
        mocks.set(mutation.value.id, mutation.value);
        break;
      case 'practiceDay':
        if (!isSafeMapKey(mutation.day)) break;
        practiceDays[mutation.day] = true;
        break;
      case 'badge': {
        // Same guard as `progress` above: `badges['constructor']` is a function,
        // and `Math.min(fn, number)` silently yields `NaN`.
        if (!isSafeMapKey(mutation.badge)) break;
        const existing = Object.prototype.hasOwnProperty.call(badges, mutation.badge)
          ? badges[mutation.badge]
          : undefined;
        // Earliest earn time wins, matching the document merge.
        badges[mutation.badge] =
          existing === undefined ? mutation.earnedAt : Math.min(existing, mutation.earnedAt);
        break;
      }
      case 'xp':
        xp = Math.max(xp, mutation.value);
        break;
    }
  }

  return {
    hasSettings: settings !== null,
    doc: {
      schemaVersion: DB_VERSION,
      // `updatedAt: 0` placeholder when no settings mutation is queued, so the
      // remote settings win the merge. `push` additionally restores the remote
      // record verbatim in that case — see the comment there.
      settings: settings ?? defaultSettings(0),
      progress,
      sessions: [...sessions.values()],
      mocks: [...mocks.values()],
      practiceDays,
      badges,
      xp,
      updatedAt,
    },
  };
}

/**
 * The pure core of `push`: what the remote document must become once the queued
 * mutations are applied to it.
 *
 * Extracted from the transaction body on purpose — this is the part that can
 * lose another device's data if it is wrong, and it is fully unit-testable
 * without a Firebase project. The transaction around it only supplies `remote`
 * and writes the result back.
 *
 * @param remote the validated remote document, or `null` when none exists yet.
 */
export function applyMutations(
  remote: ProgressDoc | null,
  mutations: readonly Mutation[],
): ProgressDoc {
  const overlay = overlayFromMutations(mutations);
  if (remote === null) return overlay.doc;
  const merged = mergeDocs(remote, overlay.doc);
  // A push that carries no settings mutation must not touch the remote settings
  // at all. The overlay's placeholder record exists only to satisfy the type,
  // and an `updatedAt` tie must never let it win.
  return overlay.hasSettings ? merged : { ...merged, settings: remote.settings };
}

/* ──────────────────────────── remote reset ──────────────────────────── */

/**
 * The capability of erasing the cloud copy.
 *
 * It is a **separate interface from `SyncAdapter`** on purpose: `SyncAdapter`
 * lives in `src/types/index.ts`, which is the frozen contract shared by the
 * storage, sync and UI workstreams, and this workstream does not own it. An
 * intersection type is fully compatible either way — if the contract later grows
 * a `resetRemote` member, `createFirestoreAdapter` already satisfies it and this
 * interface can simply be deleted.
 *
 * Callers should not type against this directly; use {@link resetRemoteProgress},
 * which works for *any* adapter, configured or not.
 */
export interface RemoteResettable {
  /**
   * Replace the cloud copy with `cleared`, overwriting whatever is there.
   *
   * @param cleared the already-wiped local document (e.g. `defaultProgressDoc`),
   *   so local and remote end up byte-identical.
   */
  resetRemote(cleared: ProgressDoc): Promise<void>;
}

/** True when `adapter` can erase a cloud copy (i.e. it is not the no-op one). */
export function supportsRemoteReset(
  adapter: SyncAdapter,
): adapter is SyncAdapter & RemoteResettable {
  return 'resetRemote' in adapter && typeof adapter.resetRemote === 'function';
}

/**
 * Erase the cloud copy of the user's progress, for any adapter.
 *
 * This is the function the store should call from its "delete everything" flow.
 * It is safe to call unconditionally: an adapter without the capability (the
 * no-op one) resolves silently, because there is no cloud copy to erase.
 *
 * ## Contract the store relies on
 *
 * 1. **Call it *after* the local wipe has already succeeded.** A rejection here
 *    must not roll the local wipe back: the user asked for their data to be
 *    gone, and it is gone locally. This function performs no local writes at all,
 *    so it cannot undo anything.
 * 2. **A failure is never swallowed.** Unlike the outbox push path — where a
 *    failure just means "try again later" — the user is waiting to be told
 *    whether their cloud data is gone. Everything this can throw is a
 *    {@link SyncError}; unexpected failures are normalised to code
 *    `'reset-failed'` with the original error as `cause`, so one `catch` covers
 *    every case. Suggested UI copy: *"Your data on this device was deleted, but
 *    the cloud copy could not be reached. Sign in again and retry."*
 * 3. `code === 'signed-out'` is the common recoverable case (configured build,
 *    nobody signed in). If the user was never signed in at all there is very
 *    likely nothing in the cloud, so it is reasonable for the UI to ignore that
 *    one code when `adapter.account() === null` was already true beforehand.
 *
 * ## Known limitation: other devices
 *
 * This clears *this* device and the cloud. A second device that is signed in and
 * still holds a full copy will re-upload it on its next push, because the merge
 * has no tombstones — deletion is not a value that can win a merge. Resetting
 * everywhere means resetting on each device (or signing out on the others
 * first). Surfacing that in the confirmation dialog is a UI decision.
 */
export async function resetRemoteProgress(
  adapter: SyncAdapter,
  cleared: ProgressDoc,
): Promise<void> {
  if (!supportsRemoteReset(adapter)) return;
  try {
    await adapter.resetRemote(cleared);
  } catch (error) {
    if (isSyncError(error)) throw error;
    throw new SyncError('reset-failed', 'could not erase the cloud copy', { cause: error });
  }
}

/**
 * The exact payload a reset writes: the cleared document and nothing else.
 *
 * Exported for tests, and to make the central property obvious — a reset is a
 * **full overwrite, not a merge**. Routing the reset through `mergeDocs` (which
 * maxes counters and unions collections) would resurrect every counter the user
 * just deleted, which is the bug this path exists to prevent.
 *
 * @throws {SyncError} `'too-large'` — impossible in practice for a cleared doc.
 */
export function resetRemotePayload(cleared: ProgressDoc): Record<string, unknown> {
  return toRemoteData(cleared);
}

/* ─────────────────────── capability: account deletion ───────────────────── */

/**
 * Optional capability: erase the account itself, not just its data.
 *
 * Separate from {@link RemoteResettable} because they answer different questions.
 * A reset means *"forget what I studied"* and leaves the user signed in with an
 * empty document. Deletion means *"forget me"* — the Firestore document and the
 * Firebase auth record (which holds the email address, display name and sign-in
 * timestamps) both go, and the user ends up signed out.
 *
 * Use {@link deleteSyncAccount}, which works for any adapter.
 */
export interface AccountDeletable {
  deleteAccount(): Promise<void>;
}

/** True when `adapter` can delete an account (i.e. it is not the no-op one). */
export function supportsAccountDeletion(
  adapter: SyncAdapter,
): adapter is SyncAdapter & AccountDeletable {
  return 'deleteAccount' in adapter && typeof adapter.deleteAccount === 'function';
}

/**
 * Delete the signed-in account and its cloud document, for any adapter.
 *
 * Safe to call unconditionally: an adapter without the capability resolves
 * silently, because there is no account to delete.
 *
 * ## Why the document goes first
 *
 * `firestore.rules` gates every operation on `isOwner(uid)`. The moment the auth
 * record is gone there is no request that can satisfy that rule, so a document
 * outliving its account is unreachable by *everyone*, forever — not even its
 * owner can delete it, and it still contains their answer history. Deleting the
 * document first can only ever leave the opposite residue: an empty account the
 * user can delete again by pressing the button a second time. One ordering has a
 * recoverable failure mode and the other does not.
 *
 * ## What the caller must handle
 *
 * Every rejection is a {@link SyncError}:
 * - `'reauth-cancelled'` — the user dismissed the re-auth prompt. Nothing was
 *   deleted. Do not show an error; show nothing, or an invitation to retry.
 * - `'signed-out'` — nobody is signed in, so there is nothing to delete.
 * - `'delete-failed'` — say plainly that the account may still exist and offer a
 *   retry. Never report success here.
 *
 * Wiping *local* data is the caller's job and belongs after this resolves. This
 * function performs no local writes beyond dropping the outbox and the session.
 */
export async function deleteSyncAccount(adapter: SyncAdapter): Promise<void> {
  if (!supportsAccountDeletion(adapter)) return;
  try {
    await adapter.deleteAccount();
  } catch (error) {
    if (isSyncError(error)) throw error;
    throw new SyncError('delete-failed', 'could not delete the account', { cause: error });
  }
}

/* ────────────────────── capability: account observation ─────────────────── */

/**
 * Optional capability: be told when the signed-in account changes underneath us.
 *
 * Polling `account()` is not enough, because the interesting changes originate
 * outside this tab and produce no user action here to react to:
 *
 *  - the user revoked the app's access from their Google account settings
 *  - the account was deleted from another device
 *  - a password change or admin action invalidated the refresh token
 *  - the user signed out in a different tab of the same browser
 *
 * In every one of those the session is gone but the UI still says "signed in as
 * …", and each write fails `permission-denied` and surfaces as a generic error.
 * Worse, the outbox keeps filling with mutations for an account that no longer
 * accepts them — which is the sign-out leak again, arrived at sideways.
 */
export interface AccountObservable {
  /**
   * Subscribe to account changes. Fires whenever the account the adapter reports
   * from `account()` actually changes — never merely because a token refreshed,
   * which Firebase's own listener does hourly and which is not news.
   *
   * It *may* fire once shortly after subscribing, when the adapter has not yet
   * adopted a session Firebase restored from a previous visit. That is a genuine
   * change from the subscriber's point of view (the `account()` they read a
   * moment ago was null and is now not), so callers should treat the callback
   * argument as authoritative rather than assume it only reports later events.
   *
   * The returned unsubscribe is idempotent.
   */
  onAccountChanged(callback: (account: SyncAccount | null) => void): Unsubscribe;
}

/** True when `adapter` reports account changes (i.e. it is not the no-op one). */
export function supportsAccountObservation(
  adapter: SyncAdapter,
): adapter is SyncAdapter & AccountObservable {
  return 'onAccountChanged' in adapter && typeof adapter.onAccountChanged === 'function';
}

/**
 * How long to wait for the server to acknowledge a reset write.
 *
 * A Firestore write resolves only once the *server* has it, so with no network
 * the promise never settles. The rest of the adapter can afford that (the outbox
 * just retries later), but a user standing in front of a "deleting…" spinner
 * cannot, and reporting success we never observed would be a lie. So the reset
 * is bounded and fails loudly instead of hanging.
 */
export const RESET_TIMEOUT_MS = 10_000;

/** Reject with `onTimeout()` if `promise` has not settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(onTimeout());
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/* ───────────────────────────── small helpers ────────────────────────── */

function toAccount(user: User): SyncAccount {
  // `email` and `displayName` really are nullable on a Firebase user (e.g. a
  // Google account with no public name); the contract says so, so honour it.
  return { uid: user.uid, email: user.email, displayName: user.displayName };
}

/** Best-effort offline detection. Absent `navigator`, assume we are online. */
function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = error.code;
    if (typeof code === 'string') return code;
  }
  return '';
}

/**
 * Distinguish "the network is not there" from "something is actually wrong".
 * `'offline'` is a warning the UI can reassure the user about; `'error'` is not.
 */
function isNetworkError(error: unknown): boolean {
  if (isOffline()) return true;
  const code = errorCode(error);
  if (code === 'unavailable' || code === 'auth/network-request-failed') return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('offline') || message.includes('network');
}

/** A popup the user closed is a normal outcome, not a failure to report. */
function isCancelledSignIn(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === 'auth/popup-closed-by-user' ||
    code === 'auth/cancelled-popup-request' ||
    code === 'auth/user-cancelled'
  );
}

/**
 * Wait for Firebase to restore a persisted session before reading
 * `currentUser`, which is `null` for a short window after page load. Without
 * this, a pull right after startup would report `'signed-out'` for an
 * already-signed-in user.
 */
async function awaitAuthReady(auth: Auth): Promise<void> {
  try {
    if (typeof auth.authStateReady === 'function') await auth.authStateReady();
  } catch (error) {
    warn('auth state did not settle', error);
  }
}

/* ──────────────────────────────── adapter ───────────────────────────── */

/**
 * Create the Firestore-backed adapter.
 *
 * `configured` is sampled from {@link isFirebaseConfigured} at construction: the
 * config is a compile-time constant, so it cannot change while the app runs.
 * When it is `false` this adapter is behaviourally identical to `./noop.ts`.
 */
export function createFirestoreAdapter(): SyncAdapter &
  RemoteResettable &
  AccountDeletable &
  AccountObservable {
  const configured = isFirebaseConfigured();

  let status: SyncStatus = 'signed-out';
  let account: SyncAccount | null = null;
  /** Live `onSnapshot` detach functions, so sign-out can stop listening. */
  const listeners = new Set<FirestoreUnsubscribe>();
  /** Subscribers to account changes; see {@link AccountObservable}. */
  const accountWatchers = new Set<(account: SyncAccount | null) => void>();
  /** The `onAuthStateChanged` detach, installed at most once per adapter. */
  let detachAuthWatch: (() => void) | null = null;

  function detachAll(): void {
    for (const detach of listeners) {
      try {
        detach();
      } catch (error) {
        warn('detaching a snapshot listener failed', error);
      }
    }
    listeners.clear();
  }

  function notifyAccountWatchers(): void {
    for (const watcher of accountWatchers) {
      try {
        watcher(account);
      } catch (error) {
        // A throwing subscriber must not break the session teardown it is
        // reacting to, nor starve the subscribers after it.
        warn('account watcher threw', error);
      }
    }
  }

  /**
   * Everything that must happen locally when a session ends, whichever way it
   * ended: the user pressed sign out, the account was deleted, or Firebase told
   * us the credential is no longer valid.
   *
   * Clearing the outbox is the load-bearing part. The queue is not scoped to an
   * account, so mutations left behind get pushed into whichever account signs in
   * next — on a shared device that uploads one person's answer history, notes and
   * chosen Bundesland into a stranger's document. Losing the queue is the right
   * trade: a mutation is an absolute snapshot of state that is *already* in
   * IndexedDB, so nothing the user did is destroyed, and the next cycle for the
   * account that owns the document pushes the whole thing anyway (see
   * `mutationsFromDoc` in `./cycle.ts`).
   *
   * Never rejects. A session must always be droppable — a failure here must not
   * leave the user holding a credential they asked to be rid of.
   */
  async function endSessionLocally(): Promise<void> {
    detachAll();
    try {
      const { clear } = await import('@/lib/db/outbox');
      await clear();
    } catch (error) {
      warn('could not clear the outbox while ending the session', error);
    }
    account = null;
    status = 'signed-out';
  }

  /** Resolve the signed-in uid, adopting a session restored by Firebase. */
  async function currentUid(handle: FirebaseHandle): Promise<string | null> {
    await awaitAuthReady(handle.auth);
    const user = handle.auth.currentUser;
    if (user === null) {
      account = null;
      return null;
    }
    account = toAccount(user);
    return user.uid;
  }

  return {
    name: FIRESTORE_ADAPTER_NAME,
    configured,

    status(): SyncStatus {
      // Unconfigured is not a failure: report exactly what the no-op adapter
      // reports so the UI needs no special case.
      if (!configured || account === null) return 'signed-out';
      // An explicit error outranks connectivity; otherwise being offline is the
      // more useful truth than a stale 'synced'.
      if (status !== 'error' && isOffline()) return 'offline';
      return status;
    },

    account(): SyncAccount | null {
      return configured ? account : null;
    },

    async signIn(): Promise<void> {
      if (!configured) return; // no-op parity: resolve silently
      const handle = await getFirebase();
      if (handle === null) {
        status = 'signed-out';
        return;
      }
      status = 'syncing';
      try {
        const { signInWithGoogle } = await import('./googleAuth');
        const credential = await signInWithGoogle(handle.auth);
        account = toAccount(credential.user);
        status = isOffline() ? 'offline' : 'synced';
      } catch (error) {
        if (isCancelledSignIn(error)) {
          // The user dismissed the sign-in UI; leave the previous state alone.
          status = account === null ? 'signed-out' : 'synced';
          return;
        }
        warn('sign-in failed', error);
        status = isNetworkError(error) ? 'offline' : 'error';
      }
    },

    async signOut(): Promise<void> {
      if (!configured) return;
      // Stop listening first: a live listener would immediately fail with
      // permission-denied once the credential is gone.
      detachAll();
      const handle = await getFirebase();
      if (handle !== null) {
        try {
          const { signOut } = await import('firebase/auth');
          await signOut(handle.auth);
        } catch (error) {
          // Local state is cleared regardless — sign-out must always succeed
          // from the user's point of view.
          warn('sign-out failed remotely; clearing local session anyway', error);
        }
      }

      // Drops the outbox and the session. See `endSessionLocally` for why the
      // queue must not survive: it is not scoped to an account.
      await endSessionLocally();
      notifyAccountWatchers();
    },

    /**
     * Delete the Firestore document, then the auth record. See
     * {@link deleteSyncAccount} for the contract and for why that order is the
     * only safe one.
     */
    async deleteAccount(): Promise<void> {
      // Unconfigured: there is no account, so there is nothing to delete and
      // nothing to report. Same silence as `./noop.ts`.
      if (!configured) return;
      const handle = await getFirebase();
      if (handle === null) {
        throw new SyncError(
          'delete-failed',
          'the cloud connection could not be initialised, so the account was not deleted',
        );
      }
      await awaitAuthReady(handle.auth);
      const user = handle.auth.currentUser;
      if (user === null) {
        account = null;
        status = 'signed-out';
        throw new SyncError('signed-out', 'nobody is signed in, so no account was deleted');
      }

      // A live snapshot listener on a document we are about to delete would fire
      // a permission-denied error mid-deletion and flip `status` to 'error'.
      detachAll();
      status = 'syncing';

      const { deleteDoc, doc } = await import('firebase/firestore');
      const { deleteUser } = await import('firebase/auth');
      const { reauthenticateWithGoogle } = await import('./googleAuth');

      // 1. The data. Bounded, because the user is watching a spinner and being
      //    told "deleted" without server confirmation would be a lie.
      try {
        await withTimeout(
          deleteDoc(doc(handle.firestore, USERS_COLLECTION, user.uid)),
          RESET_TIMEOUT_MS,
          () =>
            new SyncError(
              'delete-failed',
              `the server did not confirm the deletion within ${RESET_TIMEOUT_MS}ms; your data may still exist`,
            ),
        );
      } catch (error) {
        warn('deleting the cloud document failed; the account was left intact', error);
        status = isNetworkError(error) ? 'offline' : 'error';
        throw isSyncError(error)
          ? error
          : new SyncError('delete-failed', 'your data could not be deleted', { cause: error });
      }

      // 2. The account. Firebase requires a recent credential for this, and a
      //    session restored from a previous visit is usually too old — so the
      //    re-auth prompt is the expected path, not an edge case.
      try {
        await deleteUser(user);
      } catch (error) {
        if (errorCode(error) !== 'auth/requires-recent-login') {
          warn('deleting the account failed; the data is gone but the account remains', error);
          status = isNetworkError(error) ? 'offline' : 'error';
          throw new SyncError(
            'delete-failed',
            'your data was deleted but the account itself could not be removed; try again',
            { cause: error },
          );
        }
        try {
          await reauthenticateWithGoogle(user);
        } catch (reauthError) {
          // Dismissing the prompt is a decision, not a fault. Report it as its own
          // code so the UI can stay quiet — but note the data really is gone, so
          // the message must not imply nothing happened.
          if (isCancelledSignIn(reauthError)) {
            status = 'synced';
            throw new SyncError(
              'reauth-cancelled',
              'your data was deleted; confirming who you are is still needed to remove the account itself',
              { cause: reauthError },
            );
          }
          warn('re-authentication for deletion failed', reauthError);
          status = isNetworkError(reauthError) ? 'offline' : 'error';
          throw new SyncError(
            'delete-failed',
            'your data was deleted but we could not confirm who you are to remove the account',
            { cause: reauthError },
          );
        }
        try {
          await deleteUser(user);
        } catch (retryError) {
          warn('deleting the account failed after re-authentication', retryError);
          status = isNetworkError(retryError) ? 'offline' : 'error';
          throw new SyncError(
            'delete-failed',
            'your data was deleted but the account itself could not be removed; try again',
            { cause: retryError },
          );
        }
      }

      // The account is gone, so the session is too — including the outbox, whose
      // mutations now address a document that no longer exists.
      await endSessionLocally();
      notifyAccountWatchers();
    },

    onAccountChanged(callback: (next: SyncAccount | null) => void): Unsubscribe {
      // Unconfigured: a real, idempotent unsubscribe whose callback never fires.
      if (!configured) return (): void => {};

      accountWatchers.add(callback);

      // One Firebase listener per adapter, shared by every watcher, installed on
      // first use so an app that never renders the sync panel never loads
      // `firebase/auth` for this.
      if (detachAuthWatch === null) {
        // Claim the slot synchronously: two subscribers in the same tick must not
        // each install a listener.
        detachAuthWatch = (): void => {};
        void (async (): Promise<void> => {
          try {
            const handle = await getFirebase();
            if (handle === null) return;
            const { onAuthStateChanged } = await import('firebase/auth');
            await awaitAuthReady(handle.auth);
            const stop = onAuthStateChanged(handle.auth, (user) => {
              const next = user === null ? null : toAccount(user);
              // Firebase re-emits the current user on registration and on token
              // refresh. Only act on real transitions, or a token refresh would
              // fire a spurious "your account changed" every hour.
              if (next?.uid === account?.uid) {
                account = next;
                return;
              }
              if (next === null) {
                // The session ended somewhere else: revoked access, an account
                // deleted from another device, a sign-out in another tab. Treat it
                // exactly like a local sign-out — above all, stop the outbox from
                // accumulating mutations for an account that will reject them.
                void endSessionLocally().then(notifyAccountWatchers, () => {
                  notifyAccountWatchers();
                });
                return;
              }
              account = next;
              status = isOffline() ? 'offline' : 'synced';
              notifyAccountWatchers();
            });
            detachAuthWatch = stop;
          } catch (error) {
            warn('could not observe the auth state', error);
            detachAuthWatch = null;
          }
        })();
      }

      return (): void => {
        accountWatchers.delete(callback);
        // Last one out turns off the Firebase listener.
        if (accountWatchers.size === 0 && detachAuthWatch !== null) {
          const stop = detachAuthWatch;
          detachAuthWatch = null; // idempotent
          try {
            stop();
          } catch (error) {
            warn('detaching the auth observer failed', error);
          }
        }
      };
    },

    async pull(): Promise<ProgressDoc | null> {
      if (!configured) return null;
      const handle = await getFirebase();
      if (handle === null) return null;
      const uid = await currentUid(handle);
      if (uid === null) {
        status = 'signed-out';
        return null;
      }
      status = 'syncing';
      try {
        const { doc, getDoc } = await import('firebase/firestore');
        const snapshot = await getDoc(doc(handle.firestore, USERS_COLLECTION, uid));
        if (!snapshot.exists()) {
          // No remote document yet — indistinguishable from a fresh account,
          // which is exactly the right semantics for the caller.
          status = 'synced';
          return null;
        }
        const parsed = parseRemoteProgressDoc(snapshot.data());
        if (parsed === null) {
          warn('remote document failed validation; ignoring it');
          status = 'error';
          return null;
        }
        status = 'synced';
        return parsed;
      } catch (error) {
        warn('pull failed', error);
        status = isNetworkError(error) ? 'offline' : 'error';
        return null;
      }
    },

    async push(mutations: readonly Mutation[]): Promise<void> {
      // Cheap no-op: nothing queued means no firebase import and no round trip.
      if (mutations.length === 0) return;
      if (!configured) return; // no-op parity: accept and discard
      const handle = await getFirebase();
      if (handle === null) return;
      const uid = await currentUid(handle);
      if (uid === null) {
        // Rejecting (rather than resolving) is deliberate: the caller must keep
        // these mutations in the outbox instead of acking them away.
        status = 'signed-out';
        throw new SyncError('signed-out', 'cannot push while signed out');
      }

      status = 'syncing';
      try {
        const { doc, runTransaction } = await import('firebase/firestore');
        const ref = doc(handle.firestore, USERS_COLLECTION, uid);
        await runTransaction(handle.firestore, async (tx) => {
          // Read-merge-write inside a transaction: if another device writes
          // between the read and the write, Firestore retries this callback, so
          // its writes are merged rather than clobbered.
          const snapshot = await tx.get(ref);
          const existed = snapshot.exists();
          const remote = existed ? parseRemoteProgressDoc(snapshot.data()) : null;
          // Throws a typed SyncError for the two cases where overwriting would
          // destroy or downgrade data — both of which must reach the user rather
          // than being retried in silence.
          assertRemoteWritable(remote, existed);
          tx.set(ref, toRemoteData(applyMutations(remote, mutations)));
        });
        status = isOffline() ? 'offline' : 'synced';
      } catch (error) {
        warn('push failed; mutations stay queued', error);
        status = isNetworkError(error) ? 'offline' : 'error';
        throw error instanceof Error ? error : new Error(String(error));
      }
    },

    /**
     * Erase the cloud copy by overwriting it with the already-cleared local
     * document. See {@link RemoteResettable} and {@link resetRemoteProgress};
     * the store should call the latter.
     *
     * This is the one place that deliberately skips read-merge-write. Merging
     * would max the old counters back in and union the old sessions back in —
     * the user's "delete everything" would silently un-delete itself on the next
     * sync, which is exactly the bug this method exists to prevent.
     */
    async resetRemote(cleared: ProgressDoc): Promise<void> {
      // Unconfigured: there is no cloud copy, so there is nothing to erase and
      // nothing to report. Same silence as `./noop.ts`.
      if (!configured) return;
      const handle = await getFirebase();
      if (handle === null) {
        // Configured, but the SDK did not load. We cannot claim the copy is gone.
        throw new SyncError(
          'reset-failed',
          'the cloud connection could not be initialised, so the cloud copy was not cleared',
        );
      }
      const uid = await currentUid(handle);
      if (uid === null) {
        status = 'signed-out';
        throw new SyncError(
          'signed-out',
          'nobody is signed in, so the cloud copy was not cleared',
        );
      }
      status = 'syncing';
      try {
        const { doc, setDoc } = await import('firebase/firestore');
        // `setDoc` *without* `{ merge: true }` replaces the document wholesale,
        // so the old counters, sessions and mocks cannot survive. There is
        // deliberately no `assertRemoteWritable` guard here: a newer-schema
        // remote document is still this user's own data, and they asked for it
        // to be deleted. Overwriting rather than deleting is the point: a reset
        // leaves the user signed in, so the document must still exist for the
        // next cycle to merge into. `deleteAccount` is the flow that removes it.
        await withTimeout(
          setDoc(doc(handle.firestore, USERS_COLLECTION, uid), resetRemotePayload(cleared)),
          RESET_TIMEOUT_MS,
          () =>
            new SyncError(
              'reset-failed',
              `the server did not confirm the deletion within ${RESET_TIMEOUT_MS}ms; the cloud copy may still exist`,
            ),
        );
        status = 'synced';
      } catch (error) {
        warn('remote reset failed; local data is still cleared', error);
        status = isNetworkError(error) ? 'offline' : 'error';
        throw isSyncError(error)
          ? error
          : new SyncError('reset-failed', 'the cloud copy could not be cleared', { cause: error });
      }
    },

    subscribe(callback: (doc: ProgressDoc) => void): Unsubscribe {
      // Unconfigured: a real, idempotent unsubscribe whose callback never fires.
      if (!configured) return (): void => {};

      let cancelled = false;
      let detach: FirestoreUnsubscribe | null = null;

      void (async (): Promise<void> => {
        try {
          const handle = await getFirebase();
          if (handle === null || cancelled) return;
          const uid = await currentUid(handle);
          if (uid === null) {
            status = 'signed-out';
            return;
          }
          if (cancelled) return;
          const { doc, onSnapshot } = await import('firebase/firestore');
          if (cancelled) return;
          const stop = onSnapshot(
            doc(handle.firestore, USERS_COLLECTION, uid),
            (snapshot) => {
              if (cancelled) return;
              if (!snapshot.exists()) {
                status = 'synced';
                return;
              }
              const parsed = parseRemoteProgressDoc(snapshot.data());
              if (parsed === null) {
                warn('snapshot failed validation; not delivering it');
                status = 'error';
                return;
              }
              status = 'synced';
              try {
                // Only ever invoked with a validated document.
                callback(parsed);
              } catch (error) {
                // A throwing subscriber must not tear down the listener.
                warn('subscriber threw', error);
              }
            },
            (error) => {
              // Report through status; never throw into the UI.
              warn('snapshot listener failed', error);
              status = isNetworkError(error) ? 'offline' : 'error';
            },
          );
          if (cancelled) {
            stop();
            return;
          }
          detach = stop;
          listeners.add(stop);
        } catch (error) {
          warn('could not subscribe', error);
          status = isNetworkError(error) ? 'offline' : 'error';
        }
      })();

      return (): void => {
        cancelled = true;
        const stop = detach;
        detach = null; // idempotent: a second call has nothing left to do
        if (stop !== null) {
          listeners.delete(stop);
          try {
            stop();
          } catch (error) {
            warn('unsubscribe failed', error);
          }
        }
      };
    },
  };
}
