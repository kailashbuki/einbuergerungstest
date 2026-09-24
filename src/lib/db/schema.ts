/**
 * IndexedDB schema for the Einbürgerungstest PWA.
 *
 * This file is pure description + defaults + coercion. It knows the *shape* of
 * every object store but performs no I/O; `migrations.ts` owns the versioned
 * evolution of these stores and `index.ts` owns the public API.
 *
 * Design notes
 * ------------
 * - IndexedDB is the single local source of truth. `localStorage` is never used
 *   for user data: it is synchronous, size-limited and evicted more eagerly.
 * - Per-question progress is keyed by question id (`F001`, `BW03`). The id
 *   already encodes the scope, so federal progress is automatically shared
 *   across states and each state's progress is namespaced. This is what makes
 *   `resetState()` a cheap key-range delete (see `index.ts`).
 * - Every record read back from disk is passed through a `coerce*` function so a
 *   corrupt or partial write degrades to defaults instead of bricking the app.
 */

import type { DBSchema } from 'idb';
import type {
  MockResult,
  ProgressDoc,
  QuestionProgress,
  SessionResult,
  Settings,
  StateCode,
  Mutation,
  AnswerRecord,
  OptionKey,
  SessionMode,
  UiLocale,
  TranslationSetting,
  ThemeSetting,
} from '@/types';
import { isStateCode, STATE_CODES } from '@/data/states';

/* ────────────────────────────── identity ────────────────────────────── */

export const DB_NAME = 'einbuergerungstest';

/** Key of the single record in the `settings` store. */
export const SETTINGS_KEY = 'settings';

/** SM-2-lite starting ease. Mirrors the scheduler's default. */
export const DEFAULT_EASE = 2.5;

/** Federal question ids start with this prefix; state ids start with the state code. */
export const FEDERAL_PREFIX = 'F';

/* ─────────────────────────────── stores ─────────────────────────────── */

/**
 * `meta` is a tiny out-of-line key/value store. Keys are fixed and typed by
 * {@link MetaShape}; values are only ever primitives so they survive
 * structured-clone in every engine.
 */
export interface MetaShape {
  /** Schema version the data was last written by. Informational; IDB owns the real version. */
  readonly schemaVersion: number;
  /** Stable id for this installation. Survives `resetAll()`. */
  readonly installId: string;
  /** Stable id for this device/browser profile. Survives `resetAll()`. */
  readonly deviceId: string;
  /** Epoch ms of the last successful sync, or `null` when never synced. */
  readonly lastSyncAt: number | null;
  /** Total XP. Lives in `meta` because it is a single scalar counter. */
  readonly xp: number;
  /** Epoch ms of the last local write to the document. */
  readonly updatedAt: number;
  /** Monotonic counter used to break `at` ties in the outbox (FIFO insertion order). */
  readonly outboxSeq: number;
}

export type MetaKey = keyof MetaShape;

/** Anything storable in `meta`. */
export type MetaValue = string | number | null;

/** A snapshot row. Keys are auto-incremented so two snapshots in the same ms cannot collide. */
export type SnapshotReason = 'auto' | 'manual' | 'pre-restore' | 'pre-import';

export interface StoredSnapshot {
  /** Epoch ms the snapshot was taken. */
  readonly at: number;
  /** Why it was taken — surfaced in the Settings UI. */
  readonly reason: SnapshotReason;
  /** The whole document at that point in time. */
  readonly doc: ProgressDoc;
}

/**
 * The outbox stores mutations keyed by mutation id. `seq` is an internal
 * ordering field appended on write and stripped again by `outbox.peek()`, so
 * consumers only ever see a plain {@link Mutation}.
 */
export type OutboxRecord = Mutation & { readonly seq: number };

export interface EbtDBSchema extends DBSchema {
  meta: {
    key: MetaKey;
    value: MetaValue;
  };
  settings: {
    key: string;
    value: Settings;
  };
  /** Keyed by question id. Out-of-line: `QuestionProgress` has no id field. */
  progress: {
    key: string;
    value: QuestionProgress;
  };
  sessions: {
    key: string;
    value: SessionResult;
    indexes: { 'by-state': StateCode; 'by-finishedAt': number };
  };
  mocks: {
    key: string;
    value: MockResult;
    indexes: { 'by-state': StateCode; 'by-finishedAt': number };
  };
  /** Keyed by `YYYY-MM-DD`; the value is always `true`. */
  practiceDays: {
    key: string;
    value: boolean;
  };
  /** Keyed by badge id; the value is the earned-at epoch ms. */
  badges: {
    key: string;
    value: number;
  };
  /** Auto-incrementing keys, newest last. */
  snapshots: {
    key: number;
    value: StoredSnapshot;
  };
  /** Keyed by mutation id. */
  outbox: {
    key: string;
    value: OutboxRecord;
  };
}

export type StoreName = keyof EbtDBSchema;

/** Every store that holds user data (i.e. everything a full reset clears). */
export const DATA_STORES = [
  'settings',
  'progress',
  'sessions',
  'mocks',
  'practiceDays',
  'badges',
] as const satisfies readonly StoreName[];

export const ALL_STORES = [
  'meta',
  ...DATA_STORES,
  'snapshots',
  'outbox',
] as const satisfies readonly StoreName[];

/* ────────────────────────────── defaults ────────────────────────────── */

export function defaultSettings(now = 0): Settings {
  return {
    state: null,
    uiLocale: 'de',
    translation: 'off',
    alwaysShowTranslation: false,
    mockTranslations: false,
    recallFirst: false,
    tts: false,
    ttsAutoplay: false,
    theme: 'system',
    onboarded: false,
    updatedAt: now,
  };
}

export function defaultQuestionProgress(now = 0): QuestionProgress {
  return {
    seen: 0,
    correct: 0,
    wrong: 0,
    consecutiveCorrect: 0,
    hintsUsed: 0,
    lastSeen: 0,
    ease: DEFAULT_EASE,
    dueAt: 0,
    flagged: false,
    note: '',
    updatedAt: now,
  };
}

/**
 * A complete, valid, empty document. `loadProgressDoc()` returns exactly this
 * (modulo `schemaVersion`) on a fresh database so the app boots into onboarding
 * instead of crashing on undefined.
 */
export function defaultProgressDoc(schemaVersion: number, now = 0): ProgressDoc {
  return {
    schemaVersion,
    settings: defaultSettings(now),
    progress: {},
    sessions: [],
    mocks: [],
    practiceDays: {},
    badges: {},
    xp: 0,
    updatedAt: now,
  };
}

/* ───────────────────────────── coercion ─────────────────────────────── */

const UI_LOCALES: readonly UiLocale[] = ['de', 'en', 'tr', 'ru', 'fr', 'ar', 'uk', 'hi'];
const TRANSLATIONS: readonly TranslationSetting[] = [
  'off',
  'en',
  'tr',
  'ru',
  'fr',
  'ar',
  'uk',
  'hi',
];
const THEMES: readonly ThemeSetting[] = ['light', 'dark', 'system'];
const SESSION_MODES: readonly SessionMode[] = ['learn', 'drill', 'mock', 'speed', 'reverse'];
const OPTION_KEY_SET: readonly OptionKey[] = ['a', 'b', 'c', 'd'];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  const n = num(value, fallback);
  return n < 0 ? fallback : n;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Turn whatever is on disk into a valid `QuestionProgress`. Missing fields get
 * defaults; this is also what makes reading v1-shaped records (no `ease` /
 * `dueAt` / `flagged`) safe even outside a migration.
 */
export function coerceQuestionProgress(value: unknown, now = 0): QuestionProgress | null {
  if (!isRecord(value)) return null;
  const base = defaultQuestionProgress(now);
  const lastSeen = nonNegative(value['lastSeen'], base.lastSeen);
  return {
    seen: nonNegative(value['seen'], base.seen),
    correct: nonNegative(value['correct'], base.correct),
    wrong: nonNegative(value['wrong'], base.wrong),
    consecutiveCorrect: nonNegative(value['consecutiveCorrect'], base.consecutiveCorrect),
    hintsUsed: nonNegative(value['hintsUsed'], base.hintsUsed),
    lastSeen,
    ease: num(value['ease'], base.ease),
    dueAt: nonNegative(value['dueAt'], lastSeen),
    flagged: bool(value['flagged'], base.flagged),
    note: str(value['note'], base.note),
    updatedAt: nonNegative(value['updatedAt'], base.updatedAt),
  };
}

export function coerceSettings(value: unknown, now = 0): Settings {
  const base = defaultSettings(now);
  if (!isRecord(value)) return base;
  const rawState = value['state'];
  return {
    state: typeof rawState === 'string' && isStateCode(rawState) ? rawState : base.state,
    uiLocale: oneOf(value['uiLocale'], UI_LOCALES, base.uiLocale),
    translation: oneOf(value['translation'], TRANSLATIONS, base.translation),
    alwaysShowTranslation: bool(value['alwaysShowTranslation'], base.alwaysShowTranslation),
    mockTranslations: bool(value['mockTranslations'], base.mockTranslations),
    recallFirst: bool(value['recallFirst'], base.recallFirst),
    tts: bool(value['tts'], base.tts),
    ttsAutoplay: bool(value['ttsAutoplay'], base.ttsAutoplay),
    theme: oneOf(value['theme'], THEMES, base.theme),
    onboarded: bool(value['onboarded'], base.onboarded),
    updatedAt: nonNegative(value['updatedAt'], base.updatedAt),
  };
}

function coerceAnswers(value: unknown): AnswerRecord[] {
  if (!Array.isArray(value)) return [];
  const out: AnswerRecord[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const questionId = str(raw['questionId'], '');
    if (questionId === '') continue;
    const chosen = raw['chosen'];
    out.push({
      questionId,
      chosen:
        typeof chosen === 'string' && (OPTION_KEY_SET as readonly string[]).includes(chosen)
          ? (chosen as OptionKey)
          : null,
      correct: bool(raw['correct'], false),
      hintsUsed: nonNegative(raw['hintsUsed'], 0),
      ms: nonNegative(raw['ms'], 0),
    });
  }
  return out;
}

/**
 * Best-effort state recovery for legacy records written before sessions carried
 * a `state`. State question ids are prefixed with the state code, so a session
 * that touched any state question tells us which state it was taken under.
 */
export function inferStateFromAnswers(answers: readonly AnswerRecord[]): StateCode | null {
  for (const answer of answers) {
    const prefix = answer.questionId.slice(0, 2).toUpperCase();
    if (isStateCode(prefix)) return prefix;
  }
  return null;
}

/** Last-resort state for legacy records we cannot attribute. Never drops data. */
export const FALLBACK_STATE: StateCode = STATE_CODES[0];

export function coerceSessionResult(value: unknown, fallbackState: StateCode): SessionResult | null {
  if (!isRecord(value)) return null;
  const id = str(value['id'], '');
  if (id === '') return null;
  const answers = coerceAnswers(value['answers']);
  const rawState = value['state'];
  const state =
    typeof rawState === 'string' && isStateCode(rawState)
      ? rawState
      : (inferStateFromAnswers(answers) ?? fallbackState);
  const levelId = value['levelId'];
  const base: SessionResult = {
    id,
    mode: oneOf(value['mode'], SESSION_MODES, 'learn'),
    state,
    startedAt: nonNegative(value['startedAt'], 0),
    finishedAt: nonNegative(value['finishedAt'], 0),
    answers,
    correct: nonNegative(value['correct'], answers.filter((a) => a.correct).length),
    total: nonNegative(value['total'], answers.length),
  };
  // `exactOptionalPropertyTypes` is on: omit `levelId` rather than set undefined.
  return typeof levelId === 'string' ? { ...base, levelId } : base;
}

export function coerceMockResult(value: unknown, fallbackState: StateCode): MockResult | null {
  if (!isRecord(value)) return null;
  const id = str(value['id'], '');
  if (id === '') return null;
  const answers = coerceAnswers(value['answers']);
  const rawState = value['state'];
  const state =
    typeof rawState === 'string' && isStateCode(rawState)
      ? rawState
      : (inferStateFromAnswers(answers) ?? fallbackState);
  const correct = nonNegative(value['correct'], answers.filter((a) => a.correct).length);
  const total = nonNegative(value['total'], answers.length);
  const startedAt = nonNegative(value['startedAt'], 0);
  const finishedAt = nonNegative(value['finishedAt'], 0);
  return {
    id,
    state,
    startedAt,
    finishedAt,
    durationMs: nonNegative(value['durationMs'], Math.max(0, finishedAt - startedAt)),
    answers,
    correct,
    total,
    passed: bool(value['passed'], false),
  };
}

/* ───────────────────────── key-range scoping ────────────────────────── */

/**
 * Key range covering every question id belonging to `state`.
 *
 * Question ids are `<prefix><number>` where the prefix is either `F` (federal,
 * shared by every state) or the two-letter state code. No state code starts with
 * `F`, so `['BW', 'BW￿']` selects exactly Baden-Württemberg's questions and
 * can never touch federal progress or another state's.
 */
export function stateKeyRange(state: StateCode): IDBKeyRange {
  return IDBKeyRange.bound(state, `${state}￿`);
}

/** True for federal question ids, which are shared across all states. */
export function isFederalQuestionId(id: string): boolean {
  return id.startsWith(FEDERAL_PREFIX);
}

/** The state a question id belongs to, or `null` for federal / unknown ids. */
export function questionIdState(id: string): StateCode | null {
  const prefix = id.slice(0, 2).toUpperCase();
  return isStateCode(prefix) ? prefix : null;
}
