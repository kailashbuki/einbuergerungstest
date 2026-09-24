/**
 * Manual export / import of the whole progress document as JSON.
 *
 * This is the escape hatch that makes the app trustworthy without an account:
 * one file, self-describing, versioned, human-readable. It is also the answer
 * when the browser refuses persistent storage (see `db/persist.ts`).
 *
 * Two invariants:
 *
 * 1. **Import never throws.** Every malformed input returns a discriminated
 *    failure with a reason the Settings UI maps to `set.import.invalid`.
 * 2. **Import merges, never replaces.** Importing an old file on a device with
 *    newer progress must not roll anything back, and importing a file from
 *    another device must union the two histories.
 *
 * ## The merge seam
 *
 * The canonical two-device merge lives in `src/lib/sync/merge.ts` (owned by the
 * sync workstream). This module does **not** implement it. Instead it declares
 * the contract — {@link MergeFn} — and ships {@link conservativeMerge}, a safe
 * local default that can only ever *gain* data (`max()` on counters, union on
 * collections, latest-`updatedAt` on scalars).
 *
 * To wire the real implementation in, the app passes it at the call site; no file
 * in this module needs to change:
 *
 * ```ts
 * import { mergeDocs } from '@/lib/sync/merge';
 * import { importProgress } from '@/lib/transfer';
 *
 * const result = await importProgress(text, mergeDocs);
 * ```
 *
 * `mergeDocs` only has to satisfy `(local, incoming) => ProgressDoc`.
 */

import type {
  MockResult,
  ProgressDoc,
  QuestionId,
  QuestionProgress,
  SessionResult,
  Settings,
} from '@/types';
import {
  coerceQuestionProgress,
  coerceSettings,
  DB_VERSION,
  defaultProgressDoc,
  loadProgressDoc,
  replaceProgressDoc,
} from './db';
import {
  coerceMockResult,
  coerceSessionResult,
  FALLBACK_STATE,
  isRecord,
} from './db/schema';
import { takeSnapshot } from './db/snapshots';

/* ────────────────────────────── the payload ─────────────────────────── */

/** Format tag. Present so we can reject "some other app's JSON" outright. */
export const EXPORT_FORMAT = 'einbuergerungstest-progress';

/**
 * Payload version, independent of the IndexedDB schema version.
 *
 * Bump only for changes to the *envelope*. Older payloads must keep importing;
 * newer ones are rejected with `unsupported-version` because this build cannot
 * know what they contain.
 */
export const EXPORT_FORMAT_VERSION = 1;

export interface ExportApp {
  readonly name: string;
  /** Schema version of the document inside, for support/debugging. */
  readonly schemaVersion: number;
}

export interface ExportPayload {
  readonly format: typeof EXPORT_FORMAT;
  readonly formatVersion: number;
  /** Epoch ms. */
  readonly exportedAt: number;
  readonly app: ExportApp;
  readonly doc: ProgressDoc;
}

export function exportProgress(doc: ProgressDoc, exportedAt = Date.now()): ExportPayload {
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt,
    app: { name: 'einbuergerungstest', schemaVersion: doc.schemaVersion },
    doc,
  };
}

/** Pretty-printed so a user can eyeball (and a support engineer can diff) it. */
export function serializeExport(doc: ProgressDoc, exportedAt = Date.now()): string {
  return JSON.stringify(exportProgress(doc, exportedAt), null, 2);
}

/** `einbuergerungstest-progress-2026-09-24.json` */
export function exportFileName(at = Date.now()): string {
  const d = new Date(at);
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${EXPORT_FORMAT}-${d.getFullYear()}-${month}-${day}.json`;
}

/**
 * Trigger a real file download.
 *
 * @returns `false` when there is no DOM to download into (SSR, tests, a worker),
 * in which case the caller should fall back to `serializeExport()`.
 */
export function downloadExport(doc: ProgressDoc, at = Date.now()): boolean {
  const doc_ = globalThis.document;
  if (doc_ === undefined || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return false;
  }
  let url: string | null = null;
  try {
    const blob = new Blob([serializeExport(doc, at)], { type: 'application/json' });
    url = URL.createObjectURL(blob);
    const anchor = doc_.createElement('a');
    anchor.href = url;
    anchor.download = exportFileName(at);
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    doc_.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } catch (error) {
    console.warn('[transfer] download failed', error);
    return false;
  } finally {
    // Revoking immediately is fine: the download has already been queued.
    if (url !== null) URL.revokeObjectURL(url);
  }
}

/* ───────────────────────────── validation ───────────────────────────── */

export type ImportFailureReason =
  /** Empty or whitespace-only input. */
  | 'empty'
  /** Not valid JSON at all (truncated file, wrong encoding). */
  | 'not-json'
  /** Valid JSON, but not our envelope — missing or wrong `format` tag. */
  | 'wrong-format'
  /** A `formatVersion` from the future; this build cannot read it safely. */
  | 'unsupported-version'
  /** Our envelope, but `doc` is missing or structurally wrong. */
  | 'malformed-doc'
  /** Parsed and validated, but the local database could not be written. */
  | 'storage-failed';

export type ParseResult =
  | { readonly ok: true; readonly payload: ExportPayload }
  | { readonly ok: false; readonly reason: ImportFailureReason; readonly detail?: string };

function parseDoc(value: unknown): ProgressDoc | null {
  if (!isRecord(value)) return null;

  // Structural gate first: these five must be present and of the right kind, or
  // this is not a progress document and we refuse to guess.
  const rawProgress = value['progress'];
  const rawSessions = value['sessions'];
  const rawMocks = value['mocks'];
  const rawPracticeDays = value['practiceDays'];
  const rawBadges = value['badges'];
  if (!isRecord(rawProgress)) return null;
  if (!Array.isArray(rawSessions)) return null;
  if (!Array.isArray(rawMocks)) return null;
  if (!isRecord(rawPracticeDays)) return null;
  if (!isRecord(rawBadges)) return null;
  if (!isRecord(value['settings'])) return null;

  const settings: Settings = coerceSettings(value['settings']);
  const fallbackState = settings.state ?? FALLBACK_STATE;

  const progress: Record<QuestionId, QuestionProgress> = {};
  for (const [id, entry] of Object.entries(rawProgress)) {
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
    if (flag === true && day !== '') practiceDays[day] = true;
  }

  const badges: Record<string, number> = {};
  for (const [badge, at] of Object.entries(rawBadges)) {
    if (typeof at === 'number' && Number.isFinite(at) && at >= 0) badges[badge] = at;
  }

  const rawXp = value['xp'];
  const rawUpdatedAt = value['updatedAt'];
  const rawSchemaVersion = value['schemaVersion'];

  return {
    schemaVersion:
      typeof rawSchemaVersion === 'number' && Number.isFinite(rawSchemaVersion)
        ? rawSchemaVersion
        : DB_VERSION,
    settings,
    progress,
    sessions,
    mocks,
    practiceDays,
    badges,
    xp: typeof rawXp === 'number' && Number.isFinite(rawXp) && rawXp > 0 ? rawXp : 0,
    updatedAt:
      typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) && rawUpdatedAt > 0
        ? rawUpdatedAt
        : 0,
  };
}

/**
 * Parse and validate an export file without touching storage.
 *
 * Pure and total: any input produces a result, never an exception.
 */
export function parseExport(text: string): ParseResult {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      reason: 'not-json',
      detail: error instanceof Error ? error.message : 'unparseable',
    };
  }

  if (!isRecord(parsed)) return { ok: false, reason: 'wrong-format', detail: 'not an object' };
  if (parsed['format'] !== EXPORT_FORMAT) {
    return { ok: false, reason: 'wrong-format', detail: String(parsed['format']) };
  }

  const version = parsed['formatVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: 'wrong-format', detail: 'bad formatVersion' };
  }
  if (version > EXPORT_FORMAT_VERSION) {
    return {
      ok: false,
      reason: 'unsupported-version',
      detail: `formatVersion ${version} > ${EXPORT_FORMAT_VERSION}`,
    };
  }

  const doc = parseDoc(parsed['doc']);
  if (doc === null) return { ok: false, reason: 'malformed-doc' };

  const exportedAt = parsed['exportedAt'];
  const rawApp = parsed['app'];
  const appName = isRecord(rawApp) && typeof rawApp['name'] === 'string' ? rawApp['name'] : 'unknown';

  return {
    ok: true,
    payload: {
      format: EXPORT_FORMAT,
      formatVersion: version,
      exportedAt: typeof exportedAt === 'number' && Number.isFinite(exportedAt) ? exportedAt : 0,
      app: { name: appName, schemaVersion: doc.schemaVersion },
      doc,
    },
  };
}

/* ──────────────────────────── the merge seam ────────────────────────── */

/**
 * The merge contract shared with `src/lib/sync/merge.ts`.
 *
 * Must be pure, commutative in effect (order of two devices must not matter) and
 * monotonic: the result may never contain *less* than either input.
 */
export type MergeFn = (local: ProgressDoc, incoming: ProgressDoc) => ProgressDoc;

function mergeQuestion(local: QuestionProgress, incoming: QuestionProgress): QuestionProgress {
  // Counters are monotonic, so `max` can only lose duplicate increments — never
  // real work. Scalars follow the more recent write.
  const newer = incoming.updatedAt > local.updatedAt ? incoming : local;
  return {
    seen: Math.max(local.seen, incoming.seen),
    correct: Math.max(local.correct, incoming.correct),
    wrong: Math.max(local.wrong, incoming.wrong),
    consecutiveCorrect: Math.max(local.consecutiveCorrect, incoming.consecutiveCorrect),
    hintsUsed: Math.max(local.hintsUsed, incoming.hintsUsed),
    lastSeen: Math.max(local.lastSeen, incoming.lastSeen),
    ease: newer.ease,
    dueAt: newer.dueAt,
    flagged: newer.flagged,
    note: newer.note,
    updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
  };
}

function unionById<T extends { readonly id: string; readonly finishedAt: number }>(
  local: readonly T[],
  incoming: readonly T[],
): T[] {
  const byId = new Map<string, T>();
  for (const row of local) byId.set(row.id, row);
  // Completed sessions are immutable, so on an id clash either copy will do;
  // keeping the local one avoids pointless churn.
  for (const row of incoming) if (!byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => a.finishedAt - b.finishedAt);
}

/**
 * The safe built-in default used when no merge implementation is injected.
 *
 * Deliberately dumb and never lossy:
 * - counters: `max`
 * - per-question scalars (`ease`, `dueAt`, `flagged`, `note`): latest `updatedAt`
 * - settings: the record with the later `updatedAt` wins wholesale
 * - sessions / mocks: union by id
 * - practice days: union
 * - badges: union, earliest earn wins
 * - xp: `max`
 *
 * It does *not* attempt the cleverer reconciliation the sync layer needs (per
 * field vector clocks, tombstones, device attribution) — that is `merge.ts`.
 */
export const conservativeMerge: MergeFn = (local, incoming) => {
  const progress: Record<QuestionId, QuestionProgress> = { ...local.progress };
  for (const [id, entry] of Object.entries(incoming.progress)) {
    const mine = progress[id];
    progress[id] = mine === undefined ? entry : mergeQuestion(mine, entry);
  }

  const practiceDays: Record<string, true> = { ...local.practiceDays, ...incoming.practiceDays };

  const badges: Record<string, number> = { ...local.badges };
  for (const [badge, at] of Object.entries(incoming.badges)) {
    const mine = badges[badge];
    badges[badge] = mine === undefined ? at : Math.min(mine, at);
  }

  const settings =
    incoming.settings.updatedAt > local.settings.updatedAt ? incoming.settings : local.settings;

  return {
    schemaVersion: Math.max(local.schemaVersion, incoming.schemaVersion),
    settings,
    progress,
    sessions: unionById(local.sessions, incoming.sessions),
    mocks: unionById(local.mocks, incoming.mocks),
    practiceDays,
    badges,
    xp: Math.max(local.xp, incoming.xp),
    updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
  };
};

/* ─────────────────────────────── import ─────────────────────────────── */

export interface ImportSummary {
  /** Questions that only existed in the imported file. */
  readonly questionsAdded: number;
  readonly sessionsAdded: number;
  readonly mocksAdded: number;
  /** Id of the safety snapshot taken before the merge was written, if any. */
  readonly snapshotId: number | null;
}

export type ImportResult =
  | { readonly ok: true; readonly doc: ProgressDoc; readonly summary: ImportSummary }
  | { readonly ok: false; readonly reason: ImportFailureReason; readonly detail?: string };

/**
 * Validate `text`, merge it into the local document and persist the result.
 *
 * Nothing is written unless validation succeeds. A pre-import snapshot is taken
 * first, so an unwanted import is one click away from being undone.
 *
 * @param merge injectable merge implementation; defaults to
 * {@link conservativeMerge}. Pass `mergeDocs` from `@/lib/sync/merge` once the
 * sync layer is present.
 */
export async function importProgress(
  text: string,
  merge: MergeFn = conservativeMerge,
  now = Date.now(),
): Promise<ImportResult> {
  const parsed = parseExport(text);
  if (!parsed.ok) return parsed;
  const incoming = parsed.payload.doc;

  let local: ProgressDoc;
  try {
    local = await loadProgressDoc();
  } catch (error) {
    console.warn('[transfer] could not read local progress; merging into an empty document', error);
    local = defaultProgressDoc(DB_VERSION);
  }

  let merged: ProgressDoc;
  try {
    merged = merge(local, incoming);
  } catch (error) {
    console.warn('[transfer] merge implementation threw; falling back to the safe default', error);
    merged = conservativeMerge(local, incoming);
  }

  let snapshotId: number | null = null;
  try {
    snapshotId = await takeSnapshot(local, 'pre-import', now);
  } catch (error) {
    // Losing the safety net is not a reason to refuse the import.
    console.warn('[transfer] pre-import snapshot failed', error);
  }

  try {
    await replaceProgressDoc(merged, now);
  } catch (error) {
    return {
      ok: false,
      reason: 'storage-failed',
      detail: error instanceof Error ? error.message : 'write failed',
    };
  }

  const localSessionIds = new Set(local.sessions.map((s) => s.id));
  const localMockIds = new Set(local.mocks.map((m) => m.id));
  return {
    ok: true,
    doc: merged,
    summary: {
      questionsAdded: Object.keys(incoming.progress).filter((id) => local.progress[id] === undefined)
        .length,
      sessionsAdded: incoming.sessions.filter((s) => !localSessionIds.has(s.id)).length,
      mocksAdded: incoming.mocks.filter((m) => !localMockIds.has(m.id)).length,
      snapshotId,
    },
  };
}
