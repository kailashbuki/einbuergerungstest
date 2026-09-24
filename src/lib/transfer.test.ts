import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProgressDoc, QuestionProgress, SessionResult } from '@/types';
import {
  DB_VERSION,
  defaultProgressDoc,
  deleteDb,
  loadProgressDoc,
  putQuestionProgress,
  replaceProgressDoc,
  saveSettings,
} from './db';
import { defaultQuestionProgress } from './db/schema';
import { countSnapshots, listSnapshots } from './db/snapshots';
import {
  conservativeMerge,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  exportFileName,
  exportProgress,
  importProgress,
  parseExport,
  serializeExport,
  type MergeFn,
} from './transfer';

const T0 = 1_700_000_000_000;

function qp(overrides: Partial<QuestionProgress> = {}): QuestionProgress {
  return { ...defaultQuestionProgress(T0), seen: 1, ...overrides };
}

function session(id: string, finishedAt: number): SessionResult {
  return {
    id,
    mode: 'learn',
    state: 'BW',
    startedAt: finishedAt - 1_000,
    finishedAt,
    answers: [{ questionId: 'F001', chosen: 'a', correct: true, hintsUsed: 0, ms: 800 }],
    correct: 1,
    total: 1,
  };
}

function sampleDoc(overrides: Partial<ProgressDoc> = {}): ProgressDoc {
  const base = defaultProgressDoc(DB_VERSION, T0);
  return {
    ...base,
    settings: { ...base.settings, state: 'BW', onboarded: true, uiLocale: 'tr', updatedAt: T0 },
    progress: { F001: qp({ correct: 1 }), BW03: qp({ seen: 4, note: 'Landtag' }) },
    sessions: [session('s1', T0 + 1_000), session('s2', T0 + 2_000)],
    mocks: [],
    practiceDays: { '2025-02-01': true },
    badges: { 'first-session': T0 },
    xp: 130,
    updatedAt: T0 + 2_000,
    ...overrides,
  };
}

beforeEach(async () => {
  await deleteDb();
});

describe('exportProgress', () => {
  it('produces a self-describing, versioned payload', () => {
    const payload = exportProgress(sampleDoc(), T0);
    expect(payload.format).toBe(EXPORT_FORMAT);
    expect(payload.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(payload.exportedAt).toBe(T0);
    expect(payload.app.schemaVersion).toBe(DB_VERSION);
    expect(payload.doc).toEqual(sampleDoc());
  });

  it('serialises to pretty JSON and names the file by date', () => {
    const text = serializeExport(sampleDoc(), T0);
    expect(text).toContain('\n  ');
    expect(JSON.parse(text)).toEqual(exportProgress(sampleDoc(), T0));
    expect(exportFileName(new Date(2026, 8, 24).getTime())).toBe(
      'einbuergerungstest-progress-2026-09-24.json',
    );
  });
});

describe('parseExport', () => {
  it('accepts a payload it produced', () => {
    const result = parseExport(serializeExport(sampleDoc(), T0));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.doc).toEqual(sampleDoc());
  });

  it.each([
    ['empty input', '', 'empty'],
    ['whitespace only', '   \n ', 'empty'],
    ['truncated JSON', '{"format":"einbuergerungstest-progress","formatVersion":1,', 'not-json'],
    ['not JSON at all', 'progress file v1', 'not-json'],
    ['a JSON array', '[]', 'wrong-format'],
    ['a foreign format tag', '{"format":"some-other-app","formatVersion":1,"doc":{}}', 'wrong-format'],
    ['no format tag', '{"formatVersion":1,"doc":{}}', 'wrong-format'],
    [
      'a non-numeric formatVersion',
      '{"format":"einbuergerungstest-progress","formatVersion":"1","doc":{}}',
      'wrong-format',
    ],
  ])('rejects %s with reason %s', (_label, text, reason) => {
    const result = parseExport(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it('rejects a formatVersion from the future', () => {
    const payload = { ...exportProgress(sampleDoc(), T0), formatVersion: EXPORT_FORMAT_VERSION + 1 };
    const result = parseExport(JSON.stringify(payload));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported-version');
      expect(result.detail).toContain('formatVersion 2');
    }
  });

  it.each([
    ['a missing doc', {}],
    ['a doc that is a string', 'hello'],
    ['a doc without progress', { settings: {}, sessions: [], mocks: [], practiceDays: {}, badges: {} }],
    [
      'a doc whose sessions are not an array',
      { settings: {}, progress: {}, sessions: {}, mocks: [], practiceDays: {}, badges: {} },
    ],
    [
      'a doc without settings',
      { progress: {}, sessions: [], mocks: [], practiceDays: {}, badges: {} },
    ],
  ])('rejects %s with malformed-doc', (_label, doc) => {
    const text = JSON.stringify({
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: T0,
      doc,
    });
    const result = parseExport(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed-doc');
  });

  it('never throws, whatever it is given', () => {
    for (const text of ['', '{', 'null', 'undefined', '"a"', '0', '[1,2]', '{"format":null}']) {
      expect(() => parseExport(text)).not.toThrow();
    }
  });
});

describe('importProgress', () => {
  it('round-trips an export exactly on a fresh device', async () => {
    const doc = sampleDoc();
    const result = await importProgress(serializeExport(doc, T0), conservativeMerge, T0 + 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc).toEqual(doc);

    const reloaded = await loadProgressDoc();
    expect({ ...reloaded, updatedAt: doc.updatedAt }).toEqual(doc);
    expect(result.summary.questionsAdded).toBe(2);
    expect(result.summary.sessionsAdded).toBe(2);
  });

  it('merges rather than replaces: nothing local is lost', async () => {
    await saveSettings({ state: 'BW', onboarded: true }, T0 + 50_000);
    await putQuestionProgress('F001', qp({ seen: 10, correct: 9 }), T0 + 50_000);
    await putQuestionProgress('BW09', qp({ seen: 2 }), T0 + 50_000);

    // The incoming file knows about BW03 but has a *staler*, weaker F001.
    const incoming = sampleDoc({
      progress: { F001: qp({ seen: 1, correct: 0 }), BW03: qp({ seen: 4 }) },
    });
    const result = await importProgress(serializeExport(incoming, T0), conservativeMerge, T0 + 60_000);
    expect(result.ok).toBe(true);

    const doc = await loadProgressDoc();
    // Union of both sides.
    expect(Object.keys(doc.progress).sort()).toEqual(['BW03', 'BW09', 'F001']);
    // max() on counters: the stronger local record wins.
    expect(doc.progress['F001']?.seen).toBe(10);
    expect(doc.progress['F001']?.correct).toBe(9);
    // The newer local settings survive a staler imported copy.
    expect(doc.settings.uiLocale).toBe('de');
    if (result.ok) expect(result.summary.questionsAdded).toBe(1);
  });

  it('unions sessions, practice days, badges and takes max xp', async () => {
    await replaceProgressDoc(
      sampleDoc({
        progress: {},
        sessions: [session('local-only', T0 + 5)],
        practiceDays: { '2025-01-01': true },
        badges: { shared: T0 + 1_000, 'local-only': T0 },
        xp: 200,
      }),
      T0,
    );

    const incoming = sampleDoc({
      sessions: [session('remote-only', T0 + 6)],
      practiceDays: { '2025-01-02': true },
      badges: { shared: T0, 'remote-only': T0 },
      xp: 150,
    });
    const result = await importProgress(serializeExport(incoming, T0), conservativeMerge, T0 + 10);
    expect(result.ok).toBe(true);

    const doc = await loadProgressDoc();
    expect(doc.sessions.map((s) => s.id).sort()).toEqual(['local-only', 'remote-only']);
    expect(doc.practiceDays).toEqual({ '2025-01-01': true, '2025-01-02': true });
    // Earliest earn wins for a badge both sides have.
    expect(doc.badges).toEqual({ shared: T0, 'local-only': T0, 'remote-only': T0 });
    expect(doc.xp).toBe(200);
  });

  it('writes nothing when the payload is invalid', async () => {
    await putQuestionProgress('F001', qp({ seen: 3 }), T0);
    const before = await loadProgressDoc();

    for (const bad of ['', 'not json', '{"format":"other"}']) {
      const result = await importProgress(bad);
      expect(result.ok).toBe(false);
    }

    expect(await loadProgressDoc()).toEqual(before);
    expect(await countSnapshots()).toBe(0);
  });

  it('takes a pre-import safety snapshot of the local document', async () => {
    await saveSettings({ state: 'TH', onboarded: true }, T0);
    const result = await importProgress(serializeExport(sampleDoc(), T0), conservativeMerge, T0 + 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.summary.snapshotId).not.toBeNull();
    const snapshots = await listSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.reason).toBe('pre-import');
    // The snapshot holds the PRE-import state, so the import is undoable.
    expect(snapshots[0]?.state).toBe('TH');
  });

  it('uses an injected merge implementation — the seam for sync/merge.ts', async () => {
    const calls: Array<[number, number]> = [];
    const takeIncoming: MergeFn = (local, incoming) => {
      calls.push([Object.keys(local.progress).length, Object.keys(incoming.progress).length]);
      return incoming;
    };
    await putQuestionProgress('F009', qp({ seen: 5 }), T0);

    const result = await importProgress(serializeExport(sampleDoc(), T0), takeIncoming, T0 + 1);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([[1, 2]]);
    // The injected merge really decided the outcome.
    expect(Object.keys((await loadProgressDoc()).progress).sort()).toEqual(['BW03', 'F001']);
  });

  it('falls back to the safe default when an injected merge throws', async () => {
    const boom: MergeFn = () => {
      throw new Error('merge exploded');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await importProgress(serializeExport(sampleDoc(), T0), boom, T0 + 1);
    warn.mockRestore();
    expect(result.ok).toBe(true);
    expect(Object.keys((await loadProgressDoc()).progress).sort()).toEqual(['BW03', 'F001']);
  });
});

describe('conservativeMerge', () => {
  it('is monotonic — the result never has less than either side', () => {
    const local = sampleDoc({ progress: { F001: qp({ seen: 9, hintsUsed: 2 }) }, xp: 10 });
    const incoming = sampleDoc({ progress: { F001: qp({ seen: 4, hintsUsed: 7 }) }, xp: 30 });
    const merged = conservativeMerge(local, incoming);
    expect(merged.progress['F001']?.seen).toBe(9);
    expect(merged.progress['F001']?.hintsUsed).toBe(7);
    expect(merged.xp).toBe(30);
  });

  it('resolves per-question scalars by the later updatedAt', () => {
    const local = sampleDoc({
      progress: { F001: qp({ note: 'old', flagged: false, ease: 2.5, updatedAt: T0 }) },
    });
    const incoming = sampleDoc({
      progress: { F001: qp({ note: 'new', flagged: true, ease: 1.7, updatedAt: T0 + 1 }) },
    });
    const merged = conservativeMerge(local, incoming);
    expect(merged.progress['F001']?.note).toBe('new');
    expect(merged.progress['F001']?.flagged).toBe(true);
    expect(merged.progress['F001']?.ease).toBe(1.7);
    expect(merged.progress['F001']?.updatedAt).toBe(T0 + 1);

    // ...and the other way round.
    const reversed = conservativeMerge(incoming, local);
    expect(reversed.progress['F001']?.note).toBe('new');
  });

  it('keeps the settings record with the later updatedAt', () => {
    const local = sampleDoc();
    const incoming = sampleDoc({
      settings: { ...sampleDoc().settings, uiLocale: 'ru', updatedAt: T0 + 1 },
    });
    expect(conservativeMerge(local, incoming).settings.uiLocale).toBe('ru');
    expect(conservativeMerge(incoming, local).settings.uiLocale).toBe('ru');
  });

  it('is order-independent for the data it unions', () => {
    const a = sampleDoc({ sessions: [session('a', T0 + 1)], badges: { x: T0 + 5 } });
    const b = sampleDoc({ sessions: [session('b', T0 + 2)], badges: { x: T0 } });
    const ab = conservativeMerge(a, b);
    const ba = conservativeMerge(b, a);
    expect(ab.sessions.map((s) => s.id)).toEqual(ba.sessions.map((s) => s.id));
    expect(ab.badges).toEqual(ba.badges);
  });
});
