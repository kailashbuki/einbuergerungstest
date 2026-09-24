// The curriculum: how 310 questions become a map of small, finishable levels.
//
// Why this module exists
// ──────────────────────
// Every other prep tool ships the catalogue as one 310-question deck, which is
// endless, shapeless and demotivating. Here the catalogue is cut into 10
// hand-curated federal worlds plus one per-state Heimat world, and each world
// into levels of 10–12 questions that end in a boss level. A learner always
// sees one small, finite, winnable next step.
//
// Two rules shaped the hand curation in `src/data/curriculum.json`:
//
//  1. Levels group *semantically related* questions, never a sequential chunk
//     of ids. The Bundestag's term and the Bundestag's composition sit in the
//     same level so their explanations reinforce each other; two unrelated
//     questions that happen to be adjacent in the catalogue do not.
//  2. The upstream `category` field could not be used to form worlds: 167 of
//     the 300 federal questions are labelled `general`, and `rights-freedoms`
//     has 2. Worlds were therefore assigned by reading the question text, and
//     `world.category` is only the closest-matching upstream slug (useful for
//     icons/colours), not the source of the grouping.
//
// Federal worlds are state-independent and curated once. The Heimat world is
// *generated* per state from a single template, so all 16 Bundesländer work
// without 16× the curation effort.
//
// Known limitation: world and level names are English content strings and are
// not yet in the i18n tables — only the chrome around them is translated. When
// they are localised, the JSON should keep these names as the fallback key.

import curriculumData from '@/data/curriculum.json';
import { isCategoryId } from '@/data/categories';
import { STATES_BY_CODE, type StateCode } from '@/data/states';
import { stateQuestions } from '@/lib/deck';
import type { CategoryId, Curriculum, Level, World } from '@/types';

/* ─────────────────────────────── constants ─────────────────────────────── */

/** The generated Heimat world always uses this id, for every state. */
export const HEIMAT_WORLD_ID = 'heimat';

/** Heimat sits after the 10 federal worlds, so its display labels are `11.x`. */
export const HEIMAT_WORLD_INDEX = 11;

/**
 * Soft gating threshold. The next level opens once the previous one is 70%
 * complete — but every level stays *reachable* from the map, see
 * {@link isLevelUnlocked}.
 */
export const UNLOCK_THRESHOLD_PERCENT = 70;

/* ──────────────────────── curriculum.json → typed ──────────────────────── */

// `curriculum.json` is authored to match `World`/`Level` exactly. It cannot be
// *typed* as such by `resolveJsonModule` alone (JSON widens `category` to
// `string`), so it is validated once at import time instead of cast. A bad
// slug is an authoring mistake and should fail loudly at startup, not silently
// hand the UI a world with a category no icon exists for.

interface RawLevel {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly questionIds: readonly string[];
  readonly boss: boolean;
}

interface RawWorld {
  readonly id: string;
  readonly index: number;
  readonly name: string;
  readonly category: string;
  readonly heimat: boolean;
  readonly levels: readonly RawLevel[];
}

function toCategoryId(value: string, worldId: string): CategoryId {
  if (!isCategoryId(value)) {
    throw new Error(`curriculum.json: world "${worldId}" has unknown category "${value}"`);
  }
  return value;
}

function toLevel(raw: RawLevel): Level {
  return {
    id: raw.id,
    label: raw.label,
    name: raw.name,
    questionIds: raw.questionIds,
    boss: raw.boss,
  };
}

function toWorld(raw: RawWorld): World {
  return {
    id: raw.id,
    index: raw.index,
    name: raw.name,
    category: toCategoryId(raw.category, raw.id),
    heimat: raw.heimat,
    levels: raw.levels.map(toLevel),
  };
}

const RAW_WORLDS: readonly RawWorld[] = curriculumData.worlds;

/** The 10 hand-curated, state-independent federal worlds, in display order. */
export const FEDERAL_WORLDS: readonly World[] = RAW_WORLDS.map(toWorld);

/* ──────────────────────── the generated Heimat world ───────────────────── */

/** Stable, state-scoped level id, e.g. `heimat-bw`. */
export function heimatLevelId(state: StateCode): string {
  return `${HEIMAT_WORLD_ID}-${state.toLowerCase()}`;
}

/** True for any level id produced by {@link heimatLevelId}. */
export function isHeimatLevelId(levelId: string): boolean {
  return levelId.startsWith(`${HEIMAT_WORLD_ID}-`);
}

/**
 * The per-state Heimat world: one level, the state's 10 questions in dataset
 * order, no boss, always unlocked.
 *
 * `name` is the raw German state name (`"Bayern"`, `"Nordrhein-Westfalen"`) and
 * nothing else. The surrounding chrome ("Heimat — {state}") is a UI string that
 * lives in the i18n tables, so exposing the bare state name here keeps the
 * world name translatable and free of baked-in English. The single level uses
 * the same string for the same reason.
 */
export function heimatWorld(state: StateCode): World {
  const stateName = STATES_BY_CODE[state].name;
  return {
    id: HEIMAT_WORLD_ID,
    index: HEIMAT_WORLD_INDEX,
    name: stateName,
    heimat: true,
    levels: [
      {
        id: heimatLevelId(state),
        label: `${HEIMAT_WORLD_INDEX}.1`,
        name: stateName,
        questionIds: stateQuestions(state).map((q) => q.id),
        boss: false,
      },
    ],
  };
}

/* ────────────────────────── per-state curriculum ───────────────────────── */

const CURRICULUM_CACHE = new Map<StateCode, Curriculum>();

/**
 * The curriculum the UI renders: the 10 federal worlds plus `state`'s Heimat
 * world. Memoised per state — switching state re-derives it (and only the
 * Heimat world differs), it never mutates a shared value.
 */
export function curriculumFor(state: StateCode): Curriculum {
  const cached = CURRICULUM_CACHE.get(state);
  if (cached !== undefined) return cached;
  const curriculum: Curriculum = { worlds: [...FEDERAL_WORLDS, heimatWorld(state)] };
  CURRICULUM_CACHE.set(state, curriculum);
  return curriculum;
}

/** Every world of `state`, federal first, Heimat last. */
export function worldsOf(state: StateCode): readonly World[] {
  return curriculumFor(state).worlds;
}

export function worldById(state: StateCode, worldId: string): World | undefined {
  return worldsOf(state).find((w) => w.id === worldId);
}

/** All levels of one world, in play order (boss last). Empty for unknown ids. */
export function levelsOfWorld(state: StateCode, worldId: string): readonly Level[] {
  return worldById(state, worldId)?.levels ?? [];
}

/** Every level of `state`'s curriculum, flattened in play order. */
export function allLevels(state: StateCode): readonly Level[] {
  return worldsOf(state).flatMap((w) => w.levels);
}

export function levelById(state: StateCode, levelId: string): Level | undefined {
  return allLevels(state).find((l) => l.id === levelId);
}

/** The world a level belongs to. */
export function worldOfLevel(state: StateCode, levelId: string): World | undefined {
  return worldsOf(state).find((w) => w.levels.some((l) => l.id === levelId));
}

/**
 * The level after `levelId` in play order, crossing world boundaries — this is
 * what the "Next level" CTA follows. `undefined` on the very last level (the
 * Heimat level) or for an unknown id.
 */
export function nextLevel(state: StateCode, levelId: string): Level | undefined {
  const levels = allLevels(state);
  const at = levels.findIndex((l) => l.id === levelId);
  if (at < 0) return undefined;
  return levels[at + 1];
}

/* ───────────────────────────── soft gating ─────────────────────────────── */

/**
 * Why a level is open or closed. `unlocked === false` is a *nudge*, never a
 * hard block: the map may still let the learner in, using `previousLevelId`
 * and `previousPercent` to say "finish {previous} to 70% first" — and
 * `requiredPercent - previousPercent` to show how close they are.
 */
export interface LevelGate {
  readonly levelId: string;
  readonly unlocked: boolean;
  readonly reason:
    | 'heimat' /** Heimat is always open — it is the state-specific home stretch. */
    | 'first-in-world' /** First level of a world: always open. */
    | 'previous-cleared' /** Previous level is at or above the threshold. */
    | 'needs-previous' /** Soft-locked: show a nudge, allow entry anyway. */
    | 'unknown-level' /** Unknown id: fail open rather than trap the learner. */;
  readonly requiredPercent: number;
  readonly previousLevelId: string | null;
  readonly previousPercent: number;
}

interface LevelPosition {
  readonly previousLevelId: string | null;
}

/**
 * Position index over the federal levels only. Federal worlds are
 * state-independent, so gating needs no `StateCode`; Heimat is handled by id.
 */
const FEDERAL_LEVEL_POSITIONS: ReadonlyMap<string, LevelPosition> = (() => {
  const index = new Map<string, LevelPosition>();
  for (const world of FEDERAL_WORLDS) {
    world.levels.forEach((level, at) => {
      const previous = at === 0 ? null : (world.levels[at - 1]?.id ?? null);
      index.set(level.id, { previousLevelId: previous });
    });
  }
  return index;
})();

function percentOf(progressPercentByLevel: Readonly<Record<string, number>>, levelId: string): number {
  const raw = progressPercentByLevel[levelId] ?? 0;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, raw));
}

/**
 * Soft gating. The first level of every world and the whole Heimat world are
 * always unlocked; any other level opens once the previous level in the same
 * world reaches {@link UNLOCK_THRESHOLD_PERCENT}.
 *
 * @param progressPercentByLevel completion per level id, 0–100. Missing entries
 *   count as 0, so the caller can pass a sparse map.
 */
export function isLevelUnlocked(
  levelId: string,
  progressPercentByLevel: Readonly<Record<string, number>>,
): LevelGate {
  const base = { levelId, requiredPercent: UNLOCK_THRESHOLD_PERCENT } as const;

  if (isHeimatLevelId(levelId)) {
    return { ...base, unlocked: true, reason: 'heimat', previousLevelId: null, previousPercent: 0 };
  }

  const position = FEDERAL_LEVEL_POSITIONS.get(levelId);
  if (position === undefined) {
    return { ...base, unlocked: true, reason: 'unknown-level', previousLevelId: null, previousPercent: 0 };
  }

  const previousLevelId = position.previousLevelId;
  if (previousLevelId === null) {
    return { ...base, unlocked: true, reason: 'first-in-world', previousLevelId: null, previousPercent: 0 };
  }

  const previousPercent = percentOf(progressPercentByLevel, previousLevelId);
  const unlocked = previousPercent >= UNLOCK_THRESHOLD_PERCENT;
  return {
    ...base,
    unlocked,
    reason: unlocked ? 'previous-cleared' : 'needs-previous',
    previousLevelId,
    previousPercent,
  };
}
