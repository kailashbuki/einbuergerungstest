import { describe, expect, it } from 'vitest';

import {
  FEDERAL_WORLDS,
  HEIMAT_WORLD_ID,
  HEIMAT_WORLD_INDEX,
  UNLOCK_THRESHOLD_PERCENT,
  allLevels,
  curriculumFor,
  heimatLevelId,
  heimatWorld,
  isLevelUnlocked,
  levelById,
  levelsOfWorld,
  nextLevel,
  worldById,
  worldOfLevel,
} from '@/lib/curriculum';
import { federalQuestions, stateQuestions } from '@/lib/deck';
import { STATE_CODES, type StateCode } from '@/data/states';
import type { Level, World } from '@/types';

const FEDERAL_IDS: readonly string[] = federalQuestions().map((q) => q.id);

const normalLevels = (world: World): readonly Level[] => world.levels.filter((l) => !l.boss);
const bossLevels = (world: World): readonly Level[] => world.levels.filter((l) => l.boss);

describe('federal coverage', () => {
  // The single most important invariant in the app: a question that is in no
  // normal level is invisible to the learner forever, and a question in two
  // normal levels is busywork that inflates every completion number.
  it('places all 300 federal questions in exactly one non-boss federal level', () => {
    const owner = new Map<string, string>();
    const duplicates: string[] = [];

    for (const world of FEDERAL_WORLDS) {
      for (const level of normalLevels(world)) {
        for (const id of level.questionIds) {
          const previous = owner.get(id);
          if (previous !== undefined) duplicates.push(`${id}: ${previous} + ${level.id}`);
          else owner.set(id, level.id);
        }
      }
    }

    expect(duplicates).toEqual([]);
    expect([...owner.keys()].sort()).toEqual([...FEDERAL_IDS].sort());
    expect(owner.size).toBe(300);
  });

  it('never repeats a question inside a single level', () => {
    for (const level of FEDERAL_WORLDS.flatMap((w) => w.levels)) {
      expect(new Set(level.questionIds).size, level.id).toBe(level.questionIds.length);
    }
  });

  it('only uses ids that exist in the dataset', () => {
    const known = new Set(FEDERAL_IDS);
    for (const level of FEDERAL_WORLDS.flatMap((w) => w.levels)) {
      for (const id of level.questionIds) expect(known.has(id), `${level.id} → ${id}`).toBe(true);
    }
  });
});

describe('boss levels', () => {
  it('only contain ids from their own world (they are a mixed review of it)', () => {
    for (const world of FEDERAL_WORLDS) {
      const own = new Set(normalLevels(world).flatMap((l) => l.questionIds));
      for (const boss of bossLevels(world)) {
        for (const id of boss.questionIds) expect(own.has(id), `${boss.id} → ${id}`).toBe(true);
      }
    }
  });

  it('are the last level of every world, exactly one per world', () => {
    for (const world of FEDERAL_WORLDS) {
      expect(bossLevels(world).length, world.id).toBe(1);
      expect(world.levels.at(-1)?.boss, world.id).toBe(true);
    }
  });

  it('hold 12–16 questions', () => {
    for (const world of FEDERAL_WORLDS) {
      for (const boss of bossLevels(world)) {
        expect(boss.questionIds.length, boss.id).toBeGreaterThanOrEqual(12);
        expect(boss.questionIds.length, boss.id).toBeLessThanOrEqual(16);
      }
    }
  });
});

describe('level and world shape', () => {
  it('ships exactly 10 federal worlds, none of them Heimat', () => {
    expect(FEDERAL_WORLDS.length).toBe(10);
    for (const world of FEDERAL_WORLDS) expect(world.heimat, world.id).toBe(false);
  });

  it('gives every world at least two levels, at least one of them normal', () => {
    for (const world of FEDERAL_WORLDS) {
      expect(world.levels.length, world.id).toBeGreaterThanOrEqual(2);
      expect(normalLevels(world).length, world.id).toBeGreaterThanOrEqual(1);
    }
  });

  it('sizes normal levels at 10–12 questions', () => {
    // A world may end in one short final level when its subject matter does not
    // divide evenly; the current curation needed none, so the floor is 10
    // everywhere. If a short level is ever added it must be the world's last
    // normal level — asserted below — so the learner never hits a stub midway.
    for (const world of FEDERAL_WORLDS) {
      const normal = normalLevels(world);
      normal.forEach((level, at) => {
        expect(level.questionIds.length, level.id).toBeLessThanOrEqual(12);
        const isLastNormal = at === normal.length - 1;
        expect(level.questionIds.length, level.id).toBeGreaterThanOrEqual(isLastNormal ? 8 : 10);
      });
      expect(normal.at(-1)?.questionIds.length).toBeGreaterThanOrEqual(10);
    }
  });

  it('keeps level ids and labels unique, with labels matching world.index', () => {
    const ids = new Set<string>();
    const labels = new Set<string>();
    for (const world of FEDERAL_WORLDS) {
      world.levels.forEach((level, at) => {
        expect(ids.has(level.id), level.id).toBe(false);
        expect(labels.has(level.label), level.label).toBe(false);
        ids.add(level.id);
        labels.add(level.label);
        expect(level.label).toBe(`${world.index}.${at + 1}`);
        expect(level.name.length, level.id).toBeGreaterThan(2);
        expect(level.name, level.id).not.toMatch(/^Level \d/);
      });
    }
    expect(FEDERAL_WORLDS.map((w) => w.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('heimatWorld', () => {
  it('is generated for every state with that state’s 10 questions, in order', () => {
    for (const state of STATE_CODES) {
      const world = heimatWorld(state);
      expect(world.id).toBe(HEIMAT_WORLD_ID);
      expect(world.heimat).toBe(true);
      expect(world.index).toBe(HEIMAT_WORLD_INDEX);
      expect(world.category).toBeUndefined();
      expect(world.levels.length).toBe(1);

      const level = world.levels[0];
      expect(level).toBeDefined();
      expect(level?.boss).toBe(false);
      expect(level?.id).toBe(heimatLevelId(state));
      expect(level?.label).toBe(`${HEIMAT_WORLD_INDEX}.1`);
      expect(level?.questionIds).toEqual(stateQuestions(state).map((q) => q.id));
      expect(level?.questionIds.length).toBe(10);
    }
  });

  it('names the world with the raw German state name so the UI can translate the chrome', () => {
    expect(heimatWorld('BY').name).toBe('Bayern');
    expect(heimatWorld('NW').name).toBe('Nordrhein-Westfalen');
    expect(heimatWorld('HH').name).toBe('Hamburg');
    // No English, no "Heimat —" prefix baked into the data.
    for (const state of STATE_CODES) expect(heimatWorld(state).name).not.toMatch(/Heimat/);
  });

  it('contains Hamburg ids only for HH', () => {
    const ids = heimatWorld('HH').levels[0]?.questionIds ?? [];
    expect(ids.length).toBe(10);
    for (const id of ids) expect(id.startsWith('HH')).toBe(true);
  });

  it('works for the three city-states, which have no Landeshauptstadt question', () => {
    for (const state of ['BE', 'HB', 'HH'] satisfies StateCode[]) {
      expect(heimatWorld(state).levels[0]?.questionIds.length).toBe(10);
    }
  });
});

describe('curriculumFor', () => {
  it('covers 310 distinct questions for all 16 states', () => {
    for (const state of STATE_CODES) {
      const { worlds } = curriculumFor(state);
      expect(worlds.length).toBe(11);
      expect(worlds.filter((w) => w.heimat).length).toBe(1);

      const ids = new Set(worlds.flatMap((w) => w.levels.flatMap((l) => l.questionIds)));
      expect(ids.size, state).toBe(310);

      const heimat = worlds.at(-1);
      expect(heimat?.heimat).toBe(true);
      expect(heimat?.levels[0]?.questionIds.length).toBe(10);
      for (const id of heimat?.levels[0]?.questionIds ?? []) expect(id.startsWith(state)).toBe(true);
    }
  });

  it('never leaks another state’s questions', () => {
    const ids = curriculumFor('BW').worlds.flatMap((w) => w.levels.flatMap((l) => l.questionIds));
    expect(ids.some((id) => id.startsWith('BY'))).toBe(false);
    expect(ids.filter((id) => id.startsWith('BW')).length).toBe(10);
  });

  it('re-derives per state and is stable per state', () => {
    expect(curriculumFor('SN')).toBe(curriculumFor('SN'));
    expect(curriculumFor('SN')).not.toBe(curriculumFor('TH'));
    expect(curriculumFor('SN').worlds.at(-1)?.name).toBe('Sachsen');
    expect(curriculumFor('TH').worlds.at(-1)?.name).toBe('Thüringen');
  });
});

describe('lookups', () => {
  it('finds worlds, levels and the levels of a world', () => {
    expect(worldById('BW', 'elections')?.name).toBe('Elections');
    expect(worldById('BW', HEIMAT_WORLD_ID)?.heimat).toBe(true);
    expect(worldById('BW', 'nope')).toBeUndefined();

    expect(levelsOfWorld('BW', 'elections').length).toBe(worldById('BW', 'elections')?.levels.length);
    expect(levelsOfWorld('BW', 'nope')).toEqual([]);

    const first = FEDERAL_WORLDS[0]?.levels[0];
    expect(first).toBeDefined();
    expect(levelById('BW', first?.id ?? '')?.name).toBe(first?.name);
    expect(levelById('BW', 'nope')).toBeUndefined();
    expect(levelById('BW', heimatLevelId('BW'))?.questionIds.length).toBe(10);
    expect(levelById('BW', heimatLevelId('BY'))).toBeUndefined();

    expect(worldOfLevel('BW', first?.id ?? '')?.id).toBe(FEDERAL_WORLDS[0]?.id);
    expect(worldOfLevel('BW', heimatLevelId('BW'))?.id).toBe(HEIMAT_WORLD_ID);
  });

  it('flattens every level of the state curriculum in play order', () => {
    const levels = allLevels('BW');
    const federalLevelCount = FEDERAL_WORLDS.reduce((n, w) => n + w.levels.length, 0);
    expect(levels.length).toBe(federalLevelCount + 1);
    expect(levels.at(-1)?.id).toBe(heimatLevelId('BW'));
  });
});

describe('nextLevel', () => {
  it('walks the whole curriculum and crosses world boundaries', () => {
    const levels = allLevels('BW');
    for (let at = 0; at < levels.length - 1; at += 1) {
      expect(nextLevel('BW', levels[at]?.id ?? '')?.id).toBe(levels[at + 1]?.id);
    }
    // The boss of world 1 leads into the first level of world 2.
    const firstWorld = FEDERAL_WORLDS[0];
    const boss = firstWorld?.levels.at(-1);
    expect(boss?.boss).toBe(true);
    expect(nextLevel('BW', boss?.id ?? '')?.id).toBe(FEDERAL_WORLDS[1]?.levels[0]?.id);
  });

  it('returns undefined after the last level and for unknown ids', () => {
    expect(nextLevel('BW', heimatLevelId('BW'))).toBeUndefined();
    expect(nextLevel('BW', 'nope')).toBeUndefined();
  });
});

describe('soft gating', () => {
  const firstWorld = FEDERAL_WORLDS[0];
  const firstLevelId = firstWorld?.levels[0]?.id ?? '';
  const secondLevelId = firstWorld?.levels[1]?.id ?? '';

  it('unlocks the first level of every world at 0%', () => {
    for (const world of FEDERAL_WORLDS) {
      const gate = isLevelUnlocked(world.levels[0]?.id ?? '', {});
      expect(gate.unlocked, world.id).toBe(true);
      expect(gate.reason).toBe('first-in-world');
      expect(gate.previousLevelId).toBeNull();
    }
  });

  it('soft-locks the second level below 70% and opens it at 70%', () => {
    const locked = isLevelUnlocked(secondLevelId, { [firstLevelId]: 69 });
    expect(locked.unlocked).toBe(false);
    expect(locked.reason).toBe('needs-previous');
    expect(locked.previousLevelId).toBe(firstLevelId);
    expect(locked.previousPercent).toBe(69);
    expect(locked.requiredPercent).toBe(UNLOCK_THRESHOLD_PERCENT);

    const atThreshold = isLevelUnlocked(secondLevelId, { [firstLevelId]: 70 });
    expect(atThreshold.unlocked).toBe(true);
    expect(atThreshold.reason).toBe('previous-cleared');

    expect(isLevelUnlocked(secondLevelId, { [firstLevelId]: 100 }).unlocked).toBe(true);
    // Sparse maps are fine: a missing entry counts as 0%.
    expect(isLevelUnlocked(secondLevelId, {}).unlocked).toBe(false);
  });

  it('gates a boss level on the last normal level of its world', () => {
    const world = FEDERAL_WORLDS[0];
    const lastNormal = normalLevels(world as World).at(-1);
    const boss = world?.levels.at(-1);
    expect(isLevelUnlocked(boss?.id ?? '', {}).previousLevelId).toBe(lastNormal?.id);
    expect(isLevelUnlocked(boss?.id ?? '', { [lastNormal?.id ?? '']: 80 }).unlocked).toBe(true);
  });

  it('always unlocks Heimat, for every state', () => {
    for (const state of STATE_CODES) {
      const gate = isLevelUnlocked(heimatLevelId(state), {});
      expect(gate.unlocked, state).toBe(true);
      expect(gate.reason).toBe('heimat');
    }
  });

  it('fails open for unknown level ids rather than trapping the learner', () => {
    const gate = isLevelUnlocked('nope', {});
    expect(gate.unlocked).toBe(true);
    expect(gate.reason).toBe('unknown-level');
  });

  it('clamps nonsense progress values', () => {
    expect(isLevelUnlocked(secondLevelId, { [firstLevelId]: 1000 }).previousPercent).toBe(100);
    expect(isLevelUnlocked(secondLevelId, { [firstLevelId]: -5 }).previousPercent).toBe(0);
    expect(isLevelUnlocked(secondLevelId, { [firstLevelId]: Number.NaN }).unlocked).toBe(false);
  });
});
