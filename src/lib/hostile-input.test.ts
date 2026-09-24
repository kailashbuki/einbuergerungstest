/**
 * Documents that are structurally valid but semantically hostile.
 *
 * Both classes covered here were found by an adversarial audit, both were
 * reproduced before being fixed, and both are reachable **without an attacker
 * server** — a progress backup file shared in a WhatsApp or Telegram study group
 * is the realistic delivery mechanism, and these files do circulate that way.
 *
 * 1. **Inherited-key confusion.** `{}['constructor']` is a function, not
 *    `undefined`, and every merge in the app branches on `=== undefined`. A
 *    document keyed `constructor` therefore drove a function into a merge and
 *    threw — on every sync cycle, for ever, behind a UI that said only "you are
 *    offline".
 * 2. **Unbounded timestamps.** Every last-write-wins decision compares raw
 *    client numbers. `updatedAt: 1e308` won every comparison on every device
 *    permanently, so settings, notes and flags could never be changed again. The
 *    realistic trigger is not malice but a phone with its clock set a year ahead.
 *
 * The tests are grouped by *entry point* rather than by defect, because the
 * property that matters is that no reachable path lets either one in: the file
 * importer, the Firestore reader, the outbox replay, and both merges.
 */

import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import type { Mutation, ProgressDoc, QuestionProgress } from '@/types';
import {
  CLOCK_SKEW_ALLOWANCE_MS,
  coerceSettings,
  defaultProgressDoc,
  defaultQuestionProgress,
  defaultSettings,
  isSafeMapKey,
  MAX_XP,
} from './db/schema';
import { DB_VERSION } from './db/migrations';
import { conservativeMerge, EXPORT_FORMAT, EXPORT_FORMAT_VERSION, parseExport } from './transfer';
import { mergeDocs } from './sync/merge';
import { overlayFromMutations, parseRemoteProgressDoc } from './sync/firestore';

/** Every key that resolves to an inherited `Object.prototype` member. */
const PROTO_KEYS = [
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  '__proto__',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
] as const;

const FAR_FUTURE = 1e308;

function progressRow(overrides: Partial<QuestionProgress> = {}): QuestionProgress {
  return { ...defaultQuestionProgress(1000), ...overrides };
}

function docWith(overrides: Partial<ProgressDoc> = {}): ProgressDoc {
  return { ...defaultProgressDoc(DB_VERSION, 1000), ...overrides };
}

/** Wrap a document in the export envelope so `parseExport` will look at it. */
function exportFile(doc: unknown): string {
  return JSON.stringify({
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: 1000,
    app: { name: 'einbuergerungstest', schemaVersion: DB_VERSION },
    doc,
  });
}

describe('isSafeMapKey', () => {
  it('rejects every inherited Object.prototype member', () => {
    for (const key of PROTO_KEYS) {
      expect(isSafeMapKey(key), `${key} must be rejected`).toBe(false);
    }
  });

  it('rejects the empty string, which parseExport used to accept as a question id', () => {
    expect(isSafeMapKey('')).toBe(false);
  });

  it('accepts the ids the app actually uses', () => {
    for (const key of ['F001', 'F300', 'BW01', 'BY10', 'heimat-expert', 'streak_7']) {
      expect(isSafeMapKey(key), `${key} must be accepted`).toBe(true);
    }
  });

  it('rejects separators that could be confused with a path or a key range', () => {
    for (const key of ['a.b', 'a/b', 'a b', 'a\u0000b']) {
      expect(isSafeMapKey(key), `${key} must be rejected`).toBe(false);
    }
  });
});

describe('the file importer', () => {
  it('drops inherited-key question ids instead of importing them', () => {
    const result = parseExport(
      exportFile({
        ...docWith(),
        progress: { constructor: progressRow(), F001: progressRow({ seen: 3 }) },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The poison key is gone...
    expect(Object.keys(result.payload.doc.progress)).toEqual(['F001']);
    // ...and the legitimate row beside it was still imported. Rejecting the
    // whole file would have been the greater harm: the rest is real progress.
    expect(result.payload.doc.progress['F001']?.seen).toBe(3);
  });

  it('drops inherited keys from badges and practice days too', () => {
    const result = parseExport(
      exportFile({
        ...docWith(),
        badges: { constructor: 5, toString: 5, 'heimat-expert': 5 },
        practiceDays: { constructor: true, '2026-01-01': true },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.payload.doc.badges)).toEqual(['heimat-expert']);
    expect(Object.keys(result.payload.doc.practiceDays)).toEqual(['2026-01-01']);
  });

  it('clamps a far-future updatedAt rather than trusting it', () => {
    const before = Date.now();
    const result = parseExport(
      exportFile({
        ...docWith(),
        updatedAt: FAR_FUTURE,
        settings: { ...defaultSettings(1000), updatedAt: FAR_FUTURE },
        progress: { F001: progressRow({ updatedAt: FAR_FUTURE }) },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ceiling = Date.now() + CLOCK_SKEW_ALLOWANCE_MS;
    expect(result.payload.doc.updatedAt).toBeLessThanOrEqual(ceiling);
    expect(result.payload.doc.settings.updatedAt).toBeLessThanOrEqual(ceiling);
    expect(result.payload.doc.progress['F001']?.updatedAt).toBeLessThanOrEqual(ceiling);
    // Clamped to roughly now, not zeroed — a real recent stamp must survive.
    expect(result.payload.doc.settings.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('caps xp so it cannot be pinned by Math.max for ever', () => {
    const result = parseExport(exportFile({ ...docWith(), xp: FAR_FUTURE }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.doc.xp).toBe(MAX_XP);
  });

  it('refuses a schemaVersion this build cannot read', () => {
    const result = parseExport(exportFile({ ...docWith(), schemaVersion: 999 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.doc.schemaVersion).toBe(DB_VERSION);
  });
});

describe('the Firestore reader', () => {
  it('drops inherited-key ids from a remote document', () => {
    const parsed = parseRemoteProgressDoc({
      ...docWith(),
      progress: { constructor: progressRow(), F001: progressRow() },
      badges: { valueOf: 1, 'streak-7': 1 },
    });

    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed?.progress ?? {})).toEqual(['F001']);
    expect(Object.keys(parsed?.badges ?? {})).toEqual(['streak-7']);
  });

  it('clamps a far-future remote updatedAt and xp', () => {
    const parsed = parseRemoteProgressDoc({
      ...docWith(),
      updatedAt: FAR_FUTURE,
      xp: FAR_FUTURE,
      settings: { ...defaultSettings(1000), updatedAt: FAR_FUTURE },
    });

    const ceiling = Date.now() + CLOCK_SKEW_ALLOWANCE_MS;
    expect(parsed?.updatedAt).toBeLessThanOrEqual(ceiling);
    expect(parsed?.settings.updatedAt).toBeLessThanOrEqual(ceiling);
    expect(parsed?.xp).toBe(MAX_XP);
  });
});

describe('the outbox replay', () => {
  // `push()` calls `overlayFromMutations` on every cycle, so a single poisoned
  // mutation in the queue used to make every future push throw, permanently.
  it('survives an inherited-key mutation without throwing', () => {
    const mutations: Mutation[] = PROTO_KEYS.map((key, i) => ({
      id: `m${i}`,
      at: 1000,
      kind: 'progress',
      questionId: key,
      value: progressRow(),
    }));
    mutations.push({
      id: 'good',
      at: 1000,
      kind: 'progress',
      questionId: 'F001',
      value: progressRow({ seen: 2 }),
    });

    const overlay = overlayFromMutations(mutations);
    expect(Object.keys(overlay.doc.progress)).toEqual(['F001']);
    expect(overlay.doc.progress['F001']?.seen).toBe(2);
  });

  it('survives an inherited-key badge without producing NaN', () => {
    // `Math.min(fn, number)` is `NaN`, which used to land in the document.
    const overlay = overlayFromMutations([
      { id: 'b1', at: 1000, kind: 'badge', badge: 'constructor', earnedAt: 500 },
      { id: 'b2', at: 1000, kind: 'badge', badge: 'constructor', earnedAt: 400 },
      { id: 'b3', at: 1000, kind: 'badge', badge: 'streak-7', earnedAt: 400 },
    ]);

    expect(Object.keys(overlay.doc.badges)).toEqual(['streak-7']);
    for (const at of Object.values(overlay.doc.badges)) {
      expect(Number.isNaN(at)).toBe(false);
    }
  });
});

describe('both merges, given a document that already contains poison', () => {
  // Defence in depth: the parsers above reject these ids, but merge must stay
  // total so that a document poisoned *before* this fix shipped is recoverable
  // rather than permanently unsyncable.
  const poisoned = docWith({
    progress: Object.fromEntries(PROTO_KEYS.map((k) => [k, progressRow()])),
    badges: Object.fromEntries(PROTO_KEYS.map((k) => [k, 500])),
  });
  const clean = docWith({
    progress: { F001: progressRow({ seen: 4 }) },
    badges: { 'streak-7': 400 },
  });

  it('mergeDocs does not throw, in either argument order', () => {
    expect(() => mergeDocs(clean, poisoned)).not.toThrow();
    expect(() => mergeDocs(poisoned, clean)).not.toThrow();
  });

  it('conservativeMerge does not produce NaN counters', () => {
    // This is the merge production file imports actually use: `StorageCard`
    // calls `importProgress(text)` with no merge argument.
    const merged = conservativeMerge(clean, poisoned);
    for (const [id, row] of Object.entries(merged.progress)) {
      for (const [field, value] of Object.entries(row)) {
        if (typeof value === 'number') {
          expect(Number.isNaN(value), `${id}.${field} must not be NaN`).toBe(false);
        }
      }
    }
  });

  it('keeps the real progress intact while folding poison in', () => {
    const merged = mergeDocs(clean, poisoned);
    expect(merged.progress['F001']?.seen).toBe(4);
    expect(merged.badges['streak-7']).toBe(400);
  });
});

describe('a device with a wrong clock cannot lock settings for ever', () => {
  // The original failure: a device a year ahead wrote `settings.updatedAt`
  // ~3.1e10 ms in the future, which then beat every genuine later edit from
  // every other device, and the next sync reverted the local copy.
  it('clamps a settings record stamped a year ahead', () => {
    const aYearAhead = Date.now() + 365 * 24 * 60 * 60_000;
    const coerced = coerceSettings({ ...defaultSettings(0), uiLocale: 'ar', updatedAt: aYearAhead });

    expect(coerced.updatedAt).toBeLessThanOrEqual(Date.now() + CLOCK_SKEW_ALLOWANCE_MS);
  });

  it('lets a genuine later edit win against a clamped one', () => {
    const now = Date.now();
    const skewed = coerceSettings({ ...defaultSettings(0), uiLocale: 'ar', updatedAt: 1e308 });
    // A real edit made one minute after the clamp ceiling.
    const genuine = { ...defaultSettings(0), uiLocale: 'tr' as const, updatedAt: now + CLOCK_SKEW_ALLOWANCE_MS + 60_000 };

    const merged = mergeDocs(docWith({ settings: skewed }), docWith({ settings: genuine }));
    expect(merged.settings.uiLocale).toBe('tr');
  });

  it('still respects an ordinary few-minutes clock difference', () => {
    // The clamp must not flatten normal drift into a tie, or two devices a
    // minute apart would stop converging on the later write.
    const now = Date.now();
    const slightlyAhead = coerceSettings({
      ...defaultSettings(0),
      uiLocale: 'ar',
      updatedAt: now + 60_000,
    });
    expect(slightlyAhead.updatedAt).toBe(now + 60_000);

    const merged = mergeDocs(
      docWith({ settings: slightlyAhead }),
      docWith({ settings: { ...defaultSettings(0), uiLocale: 'tr', updatedAt: now } }),
    );
    expect(merged.settings.uiLocale).toBe('ar');
  });
});
