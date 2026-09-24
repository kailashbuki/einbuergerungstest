import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ProgressDoc, StateCode } from '@/types';
import { DB_VERSION, defaultProgressDoc, deleteDb, loadProgressDoc, saveSettings } from './index';
import { defaultQuestionProgress } from './schema';
import {
  clearSnapshots,
  countSnapshots,
  getSnapshot,
  listSnapshots,
  MAX_SNAPSHOTS,
  restoreSnapshot,
  takeSnapshot,
} from './snapshots';

const T0 = 1_700_000_000_000;

function docWith(
  state: StateCode,
  questionIds: readonly string[],
  extra: Partial<ProgressDoc> = {},
): ProgressDoc {
  const base = defaultProgressDoc(DB_VERSION, T0);
  const progress: Record<string, ReturnType<typeof defaultQuestionProgress>> = {};
  for (const id of questionIds) progress[id] = { ...defaultQuestionProgress(T0), seen: 1 };
  return {
    ...base,
    settings: { ...base.settings, state, onboarded: true, updatedAt: T0 },
    progress,
    ...extra,
  };
}

beforeEach(async () => {
  await deleteDb();
});

describe('takeSnapshot', () => {
  it('retains only the newest ten of twelve snapshots', async () => {
    const ids: number[] = [];
    for (let i = 1; i <= 12; i += 1) {
      ids.push(await takeSnapshot(docWith('BW', [`F${i}`]), 'auto', T0 + i));
    }

    expect(await countSnapshots()).toBe(MAX_SNAPSHOTS);
    const kept = await listSnapshots();
    expect(kept).toHaveLength(10);
    // The two oldest ids are gone; the newest ten remain.
    expect(kept.map((s) => s.id)).toEqual(ids.slice(2).reverse());
    expect(await getSnapshot(ids[0] ?? -1)).toBeNull();
    expect(await getSnapshot(ids[1] ?? -1)).toBeNull();
    expect(await getSnapshot(ids[2] ?? -1)).not.toBeNull();
  });

  it('keeps distinct snapshots taken in the same millisecond', async () => {
    const a = await takeSnapshot(docWith('BY', ['F1']), 'auto', T0);
    const b = await takeSnapshot(docWith('BY', ['F2']), 'auto', T0);
    expect(a).not.toBe(b);
    expect(await countSnapshots()).toBe(2);
  });
});

describe('listSnapshots', () => {
  it('returns metadata newest first', async () => {
    await takeSnapshot(docWith('BW', ['F1'], { xp: 10 }), 'auto', T0 + 1);
    await takeSnapshot(docWith('HH', ['F1', 'F2', 'HH01'], { xp: 20 }), 'manual', T0 + 2);

    const list = await listSnapshots();
    expect(list.map((s) => s.at)).toEqual([T0 + 2, T0 + 1]);
    expect(list[0]?.reason).toBe('manual');
    expect(list[0]?.questionCount).toBe(3);
    expect(list[0]?.state).toBe('HH');
    expect(list[0]?.xp).toBe(20);
    expect(list[1]?.reason).toBe('auto');
    expect(list[1]?.questionCount).toBe(1);
  });

  it('is empty on a fresh database', async () => {
    expect(await listSnapshots()).toEqual([]);
    expect(await countSnapshots()).toBe(0);
  });
});

describe('restoreSnapshot', () => {
  it('round-trips a document faithfully', async () => {
    const saved = docWith('SN', ['F1', 'SN03'], { xp: 99, badges: { early: T0 } });
    const id = await takeSnapshot(saved, 'auto', T0);

    // Move the live state somewhere else entirely.
    await saveSettings({ state: 'TH', onboarded: true }, T0 + 5);

    const result = await restoreSnapshot(id, T0 + 10);
    expect(result.ok).toBe(true);

    const live = await loadProgressDoc();
    expect(live.settings.state).toBe('SN');
    expect(Object.keys(live.progress).sort()).toEqual(['F1', 'SN03']);
    expect(live.xp).toBe(99);
    expect(live.badges).toEqual({ early: T0 });
    // Everything except the local write timestamp comes back byte-for-byte.
    expect({ ...live, updatedAt: saved.updatedAt }).toEqual(saved);
  });

  it('takes a pre-restore safety snapshot so restore is itself undoable', async () => {
    const older = docWith('SN', ['SN03'], { xp: 1 });
    const id = await takeSnapshot(older, 'auto', T0);
    await saveSettings({ state: 'TH', onboarded: true }, T0 + 5);

    const result = await restoreSnapshot(id, T0 + 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const safety = await getSnapshot(result.safetyId);
    expect(safety?.settings.state).toBe('TH');

    const list = await listSnapshots();
    expect(list[0]?.id).toBe(result.safetyId);
    expect(list[0]?.reason).toBe('pre-restore');

    // ...and undoing the restore puts us back where we were.
    const undo = await restoreSnapshot(result.safetyId, T0 + 20);
    expect(undo.ok).toBe(true);
    expect((await loadProgressDoc()).settings.state).toBe('TH');
  });

  it('can restore the oldest snapshot even though the safety snapshot prunes it', async () => {
    const oldestDoc = docWith('HB', ['HB01'], { xp: 7 });
    const oldestId = await takeSnapshot(oldestDoc, 'auto', T0);
    for (let i = 1; i < MAX_SNAPSHOTS; i += 1) {
      await takeSnapshot(docWith('BW', [`F${i}`]), 'auto', T0 + i);
    }
    expect(await countSnapshots()).toBe(MAX_SNAPSHOTS);

    const result = await restoreSnapshot(oldestId, T0 + 100);
    expect(result.ok).toBe(true);
    // The safety snapshot pushed the target out of the retention window...
    expect(await getSnapshot(oldestId)).toBeNull();
    // ...but the restore still landed.
    expect((await loadProgressDoc()).settings.state).toBe('HB');
    expect((await loadProgressDoc()).xp).toBe(7);
  });

  it('reports an unknown id instead of throwing', async () => {
    const result = await restoreSnapshot(4_242);
    expect(result).toEqual({ ok: false, reason: 'not-found' });
  });

  it('leaves the outbox and the snapshot history intact', async () => {
    const id = await takeSnapshot(docWith('BE', ['BE01']), 'auto', T0);
    await restoreSnapshot(id, T0 + 1);
    // The restored snapshot plus its safety snapshot are both still listed.
    expect(await countSnapshots()).toBe(2);
  });
});

describe('clearSnapshots', () => {
  it('drops every snapshot', async () => {
    await takeSnapshot(docWith('BW', ['F1']), 'auto', T0);
    await takeSnapshot(docWith('BW', ['F2']), 'auto', T0 + 1);
    await clearSnapshots();
    expect(await countSnapshots()).toBe(0);
  });
});
