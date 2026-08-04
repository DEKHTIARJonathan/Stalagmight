/**
 * Random, valid-by-construction mutating actions for the `undo-redo-fuzz`
 * scenario. Every generator draws ONLY from `ctx.rng()`/`randInt`/`pick` and
 * targets ids read back out of the live project, so a (seed, iterations) pair
 * replays exactly.
 *
 * Arg shapes mirror the generated IPC types in `src/types/ipc/` (SectionData,
 * ShotData, ShotUpdates, SectionUpdates, StationRef, GpsCoordinates,
 * Coordinates, ClosureStrategy) and the `projectStore` action signatures. They
 * are restated structurally rather than imported: nothing else under `e2e/`
 * reaches into `src/`, and `tsconfig.agent.json` deliberately roots only the
 * harness tree.
 *
 * `ShotUpdates` uses serde's double-option for the nullable fields: an ABSENT
 * key means "leave it alone", an explicit `null` means "clear it". Patches here
 * are built by adding only the keys being updated, so the distinction survives
 * the JSON round trip through WebDriver by construction - we never write
 * `undefined` and rely on `JSON.stringify` dropping it.
 */
import type { ScenarioContext } from './framework';

/** Mirrors `src/types/ipc/StationRef.ts`. */
export interface StationRef {
  section_id: number;
  station_index: number;
}

/** The slice of `src/types/ipc/Section.ts` the generators target. */
export interface RawSection {
  id: number;
  shots: { id: number }[];
}

/** The slice of `src/types/ipc/ProjectState.ts` the generators target. */
export interface RawProjectState {
  project: {
    sections: RawSection[];
    station_merges: { station_a: StationRef; station_b: StationRef }[];
    zero_datums: { station_ref: StationRef }[];
    loop_closures: { id: number | bigint }[];
  };
  stations: { station_ref: StationRef }[];
}

/** One drawn mutation: a `projectStore` action plus its args. */
export interface FuzzAction {
  action: string;
  args: unknown[];
  /** Short label for the action-history tail in a failure message. */
  label: string;
}

export interface ActionGenerator {
  name: string;
  /** Relative draw weight. */
  weight: number;
  /** Returns null when the live project has no valid target for this action. */
  build(ctx: ScenarioContext, state: RawProjectState): FuzzAction | null;
}

const COLORS = ['#3388FF', '#FF8833', '#33CC66', '#CC33AA', '#FFCC00', '#6666FF'] as const;
const SHOT_KINDS = ['Normal', 'Jump', 'Reference'] as const;
const SURVEY_DIRECTIONS = ['in', 'out'] as const;
/**
 * `Batch` is the deferred-distribution marker and `ProportionalByLength` /
 * `EqualDistribution` are rejected outright by `create_loop_closure`
 * (models/project/mutations.rs), so they are drawn only occasionally - a
 * rejected command is a case the model checks, just not an interesting one to
 * spend most draws on.
 */
const CLOSURE_STRATEGIES = [
  'Move',
  'Move',
  'LeastSquaresWeighted',
  'LeastSquaresWeighted',
  'ProportionalByLength',
  'EqualDistribution',
  'Batch',
] as const;

function chance(ctx: ScenarioContext, probability: number): boolean {
  return ctx.rng() < probability;
}

function roundedFloat(ctx: ScenarioContext, min: number, max: number, decimals: number): number {
  return Number((min + ctx.rng() * (max - min)).toFixed(decimals));
}

/** `count` distinct members of `items`, drawn deterministically without replacement. */
function pickDistinct<T>(ctx: ScenarioContext, items: readonly T[], count: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < count && pool.length > 0) {
    const [taken] = pool.splice(ctx.randInt(0, pool.length - 1), 1);
    if (taken !== undefined) out.push(taken);
  }
  return out;
}

/** Sections by ascending id, so the draw does not depend on Vec order. */
function sortedSections(state: RawProjectState): RawSection[] {
  return [...state.project.sections].sort((a, b) => a.id - b.id);
}

function pickSection(ctx: ScenarioContext, state: RawProjectState): RawSection | null {
  const sections = sortedSections(state);
  return sections.length > 0 ? ctx.pick(sections) : null;
}

function pickShot(
  ctx: ScenarioContext,
  state: RawProjectState,
): { section: RawSection; shotId: number } | null {
  const populated = sortedSections(state).filter((section) => section.shots.length > 0);
  if (populated.length === 0) return null;
  const section = ctx.pick(populated);
  const shotIds = section.shots.map((shot) => shot.id).sort((a, b) => a - b);
  return { section, shotId: ctx.pick(shotIds) };
}

function sortedStationRefs(state: RawProjectState): StationRef[] {
  return [...state.stations]
    .map((station) => station.station_ref)
    .sort((a, b) => a.section_id - b.section_id || a.station_index - b.station_index);
}

function pickStationRef(ctx: ScenarioContext, state: RawProjectState): StationRef | null {
  const refs = sortedStationRefs(state);
  return refs.length > 0 ? ctx.pick(refs) : null;
}

/**
 * Two stations in DIFFERENT sections. Merging or closing a loop within one
 * section is rejected up front (`command_station.rs`), so cross-section pairs
 * are the ones that can actually exercise the undo path.
 */
function pickCrossSectionPair(
  ctx: ScenarioContext,
  state: RawProjectState,
): [StationRef, StationRef] | null {
  const bySection = new Map<number, StationRef[]>();
  for (const ref of sortedStationRefs(state)) {
    const bucket = bySection.get(ref.section_id);
    if (bucket) bucket.push(ref);
    else bySection.set(ref.section_id, [ref]);
  }
  const sectionIds = [...bySection.keys()].sort((a, b) => a - b);
  if (sectionIds.length < 2) return null;
  const [idA, idB] = pickDistinct(ctx, sectionIds, 2);
  if (idA === undefined || idB === undefined) return null;
  const a = ctx.pick(bySection.get(idA) ?? []);
  const b = ctx.pick(bySection.get(idB) ?? []);
  return a && b ? [a, b] : null;
}

function refLabel(ref: StationRef): string {
  return `${ref.section_id}/${ref.station_index}`;
}

/** A valid `ShotData` (every field present; nullable ones explicitly null-or-value). */
export function randomShotData(ctx: ScenarioContext): Record<string, unknown> {
  const azimuth = roundedFloat(ctx, 0, 359.9, 1);
  const depthIn = roundedFloat(ctx, 0, 40, 2);
  const depthOut = Math.max(0, depthIn + roundedFloat(ctx, -3, 3, 2));
  return {
    azimuth_in: azimuth,
    azimuth_out: Number(((azimuth + roundedFloat(ctx, -1.5, 1.5, 1) + 360) % 360).toFixed(1)),
    length: roundedFloat(ctx, 1, 12, 2),
    depth_in: depthIn,
    depth_out: Number(depthOut.toFixed(2)),
    pitch_in: chance(ctx, 0.5) ? roundedFloat(ctx, -60, 60, 1) : null,
    pitch_out: chance(ctx, 0.5) ? roundedFloat(ctx, -60, 60, 1) : null,
    left: chance(ctx, 0.7) ? roundedFloat(ctx, 0, 5, 2) : null,
    right: chance(ctx, 0.7) ? roundedFloat(ctx, 0, 5, 2) : null,
    up: chance(ctx, 0.7) ? roundedFloat(ctx, 0, 5, 2) : null,
    down: chance(ctx, 0.7) ? roundedFloat(ctx, 0, 5, 2) : null,
    comment: chance(ctx, 0.25) ? `fuzz-shot-${ctx.randInt(0, 9999)}` : null,
    kind: ctx.pick(SHOT_KINDS),
    marker_index: chance(ctx, 0.15) ? ctx.randInt(0, 9) : null,
    temperature: chance(ctx, 0.3) ? roundedFloat(ctx, 4, 30, 1) : null,
  };
}

/** A valid `SectionData` with 1-4 shots. */
export function randomSectionData(ctx: ScenarioContext): Record<string, unknown> {
  const shotCount = ctx.randInt(1, 4);
  const shots: Record<string, unknown>[] = [];
  for (let i = 0; i < shotCount; i++) shots.push(randomShotData(ctx));
  return {
    name: `fuzz-${ctx.randInt(1000, 9999)}`,
    surveyor: chance(ctx, 0.7) ? `fuzz-surveyor-${ctx.randInt(1, 9)}` : null,
    date: `20${ctx.randInt(10, 26)}-0${ctx.randInt(1, 9)}-1${ctx.randInt(0, 9)}`,
    color: ctx.pick(COLORS),
    direction: ctx.pick(SURVEY_DIRECTIONS),
    quality: ctx.randInt(1, 5),
    shots,
  };
}

interface PatchField {
  key: string;
  /** May be set to explicit null ("clear this field"). */
  nullable: boolean;
  gen(ctx: ScenarioContext): unknown;
}

const SHOT_PATCH_FIELDS: readonly PatchField[] = [
  { key: 'azimuth_in', nullable: false, gen: (c) => roundedFloat(c, 0, 359.9, 1) },
  { key: 'azimuth_out', nullable: false, gen: (c) => roundedFloat(c, 0, 359.9, 1) },
  { key: 'length', nullable: false, gen: (c) => roundedFloat(c, 0.5, 20, 2) },
  { key: 'depth_in', nullable: false, gen: (c) => roundedFloat(c, 0, 40, 2) },
  { key: 'depth_out', nullable: false, gen: (c) => roundedFloat(c, 0, 40, 2) },
  { key: 'pitch_in', nullable: true, gen: (c) => roundedFloat(c, -60, 60, 1) },
  { key: 'pitch_out', nullable: true, gen: (c) => roundedFloat(c, -60, 60, 1) },
  { key: 'left', nullable: true, gen: (c) => roundedFloat(c, 0, 5, 2) },
  { key: 'right', nullable: true, gen: (c) => roundedFloat(c, 0, 5, 2) },
  { key: 'up', nullable: true, gen: (c) => roundedFloat(c, 0, 5, 2) },
  { key: 'down', nullable: true, gen: (c) => roundedFloat(c, 0, 5, 2) },
  { key: 'comment', nullable: true, gen: (c) => `fuzz-comment-${c.randInt(0, 9999)}` },
  { key: 'kind', nullable: false, gen: (c) => c.pick(SHOT_KINDS) },
  { key: 'marker_index', nullable: true, gen: (c) => c.randInt(0, 9) },
  { key: 'temperature', nullable: true, gen: (c) => roundedFloat(c, 4, 30, 1) },
];

const SECTION_PATCH_FIELDS: readonly PatchField[] = [
  { key: 'name', nullable: true, gen: (c) => `fuzz-renamed-${c.randInt(0, 9999)}` },
  { key: 'surveyor', nullable: true, gen: (c) => `fuzz-surveyor-${c.randInt(1, 9)}` },
  {
    key: 'date',
    nullable: true,
    gen: (c) => `20${c.randInt(10, 26)}-0${c.randInt(1, 9)}-1${c.randInt(0, 9)}`,
  },
  { key: 'color', nullable: false, gen: (c) => c.pick(COLORS) },
  { key: 'direction', nullable: false, gen: (c) => c.pick(SURVEY_DIRECTIONS) },
  { key: 'quality', nullable: false, gen: (c) => c.randInt(1, 5) },
];

/**
 * Build a partial update. Only the drawn keys are present; a nullable key is
 * set to explicit `null` ~30% of the time to exercise serde's "clear" case
 * alongside the "absent = no change" one.
 */
function buildPatch(
  ctx: ScenarioContext,
  fields: readonly PatchField[],
  count: number,
): { patch: Record<string, unknown>; label: string } {
  const patch: Record<string, unknown> = {};
  const parts: string[] = [];
  for (const field of pickDistinct(ctx, fields, count).sort((a, b) => a.key.localeCompare(b.key))) {
    if (field.nullable && chance(ctx, 0.3)) {
      patch[field.key] = null;
      parts.push(`${field.key}=null`);
    } else {
      patch[field.key] = field.gen(ctx);
      parts.push(field.key);
    }
  }
  return { patch, label: parts.join(',') };
}

function randomOffset(ctx: ScenarioContext): Record<string, number> {
  return {
    x: roundedFloat(ctx, -3, 3, 3),
    y: roundedFloat(ctx, -3, 3, 3),
    z: roundedFloat(ctx, -1.5, 1.5, 3),
  };
}

/**
 * The generator set. Weights keep the cheap structural edits dominant while
 * still reaching the graph operations (merge / closure / datum), which is where
 * the interesting undo bugs live. Deletes are held down so a long run does not
 * empty the project out.
 */
export const ACTION_GENERATORS: readonly ActionGenerator[] = [
  {
    name: 'createSection',
    weight: 6,
    build(ctx) {
      const data = randomSectionData(ctx);
      const shots = data.shots as unknown[];
      return { action: 'createSection', args: [data], label: `createSection(shots=${shots.length})` };
    },
  },
  {
    name: 'createShot',
    weight: 12,
    build(ctx, state) {
      const section = pickSection(ctx, state);
      if (!section) return null;
      const shot = randomShotData(ctx);
      const shotIds = section.shots.map((s) => s.id).sort((a, b) => a - b);
      // The PRE-insert shot count is in every label: appending into a section
      // that currently has none takes a different backend path from appending
      // onto a populated one, and that distinction has already been the
      // difference between a clean roundtrip and a displaced section.
      const where = `s=${section.id},n=${shotIds.length}`;
      const mode = shotIds.length === 0 ? 'append' : ctx.pick(['append', 'after', 'before'] as const);
      if (mode === 'after') {
        const afterId = ctx.pick(shotIds);
        return {
          action: 'createShot',
          args: [section.id, shot, afterId],
          label: `createShot(${where},after=${afterId})`,
        };
      }
      if (mode === 'before') {
        const beforeId = ctx.pick(shotIds);
        return {
          action: 'createShot',
          args: [section.id, shot, null, beforeId],
          label: `createShot(${where},before=${beforeId})`,
        };
      }
      return { action: 'createShot', args: [section.id, shot], label: `createShot(${where},append)` };
    },
  },
  {
    name: 'updateShot',
    weight: 14,
    build(ctx, state) {
      const target = pickShot(ctx, state);
      if (!target) return null;
      const { patch, label } = buildPatch(ctx, SHOT_PATCH_FIELDS, ctx.randInt(1, 4));
      return {
        action: 'updateShot',
        args: [target.section.id, target.shotId, patch],
        label: `updateShot(s=${target.section.id},shot=${target.shotId},{${label}})`,
      };
    },
  },
  {
    name: 'deleteShot',
    weight: 8,
    build(ctx, state) {
      const target = pickShot(ctx, state);
      if (!target) return null;
      return {
        action: 'deleteShot',
        args: [target.section.id, target.shotId],
        label: `deleteShot(s=${target.section.id},shot=${target.shotId})`,
      };
    },
  },
  {
    name: 'deleteSection',
    weight: 3,
    build(ctx, state) {
      // Keep at least two sections so cross-section merges stay reachable.
      if (state.project.sections.length <= 2) return null;
      const section = pickSection(ctx, state);
      if (!section) return null;
      return { action: 'deleteSection', args: [section.id], label: `deleteSection(s=${section.id})` };
    },
  },
  {
    name: 'updateSection',
    weight: 8,
    build(ctx, state) {
      const section = pickSection(ctx, state);
      if (!section) return null;
      const { patch, label } = buildPatch(ctx, SECTION_PATCH_FIELDS, ctx.randInt(1, 3));
      return {
        action: 'updateSection',
        args: [section.id, patch],
        label: `updateSection(s=${section.id},{${label}})`,
      };
    },
  },
  {
    name: 'reverseSection',
    weight: 4,
    build(ctx, state) {
      const section = pickSection(ctx, state);
      if (!section) return null;
      const swap = chance(ctx, 0.5);
      return {
        action: 'reverseSection',
        args: [section.id, swap],
        label: `reverseSection(s=${section.id},swapLR=${swap})`,
      };
    },
  },
  {
    name: 'setShotKind',
    weight: 8,
    build(ctx, state) {
      const target = pickShot(ctx, state);
      if (!target) return null;
      const kind = ctx.pick(SHOT_KINDS);
      return {
        action: 'setShotKind',
        args: [target.section.id, target.shotId, kind],
        label: `setShotKind(s=${target.section.id},shot=${target.shotId},${kind})`,
      };
    },
  },
  {
    name: 'updateStationComment',
    weight: 8,
    build(ctx, state) {
      const ref = pickStationRef(ctx, state);
      if (!ref) return null;
      const comment = chance(ctx, 0.3) ? null : `fuzz-station-${ctx.randInt(0, 9999)}`;
      return {
        action: 'updateStationComment',
        args: [ref, comment],
        label: `updateStationComment(${refLabel(ref)},${comment === null ? 'null' : 'text'})`,
      };
    },
  },
  {
    name: 'moveStation',
    weight: 8,
    build(ctx, state) {
      const ref = pickStationRef(ctx, state);
      if (!ref) return null;
      // The store types this parameter `newPosition`, but every caller (and the
      // backend `move_station`) treats it as an OFFSET.
      const offset = randomOffset(ctx);
      return {
        action: 'moveStation',
        args: [ref, offset],
        label: `moveStation(${refLabel(ref)},d=${offset.x}/${offset.y}/${offset.z})`,
      };
    },
  },
  {
    name: 'moveSection',
    weight: 5,
    build(ctx, state) {
      const section = pickSection(ctx, state);
      if (!section) return null;
      const offset = randomOffset(ctx);
      return {
        action: 'moveSection',
        args: [section.id, offset],
        label: `moveSection(s=${section.id},d=${offset.x}/${offset.y}/${offset.z})`,
      };
    },
  },
  {
    name: 'moveSegment',
    weight: 5,
    build(ctx, state) {
      const section = pickSection(ctx, state);
      if (!section) return null;
      const offset = randomOffset(ctx);
      return {
        action: 'moveSegment',
        args: [section.id, offset],
        label: `moveSegment(s=${section.id},d=${offset.x}/${offset.y}/${offset.z})`,
      };
    },
  },
  {
    name: 'mergeStations',
    weight: 6,
    build(ctx, state) {
      const pair = pickCrossSectionPair(ctx, state);
      if (!pair) return null;
      return {
        action: 'mergeStations',
        args: [pair[0], pair[1]],
        label: `mergeStations(${refLabel(pair[0])},${refLabel(pair[1])})`,
      };
    },
  },
  {
    name: 'unmergeStationPair',
    weight: 4,
    build(ctx, state) {
      const merges = [...state.project.station_merges].sort(
        (a, b) =>
          a.station_a.section_id - b.station_a.section_id ||
          a.station_a.station_index - b.station_a.station_index ||
          a.station_b.section_id - b.station_b.section_id ||
          a.station_b.station_index - b.station_b.station_index,
      );
      if (merges.length === 0) return null;
      const merge = ctx.pick(merges);
      return {
        action: 'unmergeStationPair',
        args: [merge.station_a, merge.station_b],
        label: `unmergeStationPair(${refLabel(merge.station_a)},${refLabel(merge.station_b)})`,
      };
    },
  },
  {
    name: 'setZeroDatum',
    weight: 3,
    build(ctx, state) {
      const ref = pickStationRef(ctx, state);
      if (!ref) return null;
      const gps = {
        latitude: roundedFloat(ctx, 20.2, 20.5, 6),
        longitude: roundedFloat(ctx, -87.5, -87.2, 6),
        depth_reference: roundedFloat(ctx, 0, 5, 2),
      };
      // fitToBounds:false - the camera fit is UI churn the oracle does not want.
      return {
        action: 'setZeroDatum',
        args: [ref, gps, { fitToBounds: false }],
        label: `setZeroDatum(${refLabel(ref)})`,
      };
    },
  },
  {
    name: 'removeZeroDatum',
    weight: 2,
    build(ctx, state) {
      const datums = [...state.project.zero_datums].sort(
        (a, b) =>
          a.station_ref.section_id - b.station_ref.section_id ||
          a.station_ref.station_index - b.station_ref.station_index,
      );
      if (datums.length === 0) return null;
      const datum = ctx.pick(datums);
      return {
        action: 'removeZeroDatum',
        args: [datum.station_ref],
        label: `removeZeroDatum(${refLabel(datum.station_ref)})`,
      };
    },
  },
  {
    name: 'createLoopClosure',
    weight: 3,
    build(ctx, state) {
      const pair = pickCrossSectionPair(ctx, state);
      if (!pair) return null;
      const strategy = ctx.pick(CLOSURE_STRATEGIES);
      return {
        action: 'createLoopClosure',
        args: [pair[0], pair[1], strategy],
        label: `createLoopClosure(${refLabel(pair[0])},${refLabel(pair[1])},${strategy})`,
      };
    },
  },
  {
    name: 'removeLoopClosure',
    weight: 2,
    build(ctx, state) {
      const ids = state.project.loop_closures.map((closure) => Number(closure.id)).sort((a, b) => a - b);
      if (ids.length === 0) return null;
      const id = ctx.pick(ids);
      // The store action's declared type is bigint, but it does `Number(closureId)`
      // before the invoke, so a plain number (the only thing WebDriver can carry)
      // is exactly what the IPC boundary sees anyway.
      return { action: 'removeLoopClosure', args: [id], label: `removeLoopClosure(${id})` };
    },
  },
];

/** Weight-expanded generator names, built once so draws stay cheap. */
const WEIGHTED_NAMES: readonly string[] = ACTION_GENERATORS.flatMap((generator) =>
  Array.from({ length: generator.weight }, () => generator.name),
);

const BY_NAME = new Map(ACTION_GENERATORS.map((generator) => [generator.name, generator]));

/**
 * Draw a mutation the current project actually has a target for. Retries a
 * bounded number of times (a generator returns null when, say, there are no
 * loop closures to remove), then falls back to `createSection`, which is always
 * buildable.
 */
export function drawAction(
  ctx: ScenarioContext,
  state: RawProjectState,
  attempts = 8,
): FuzzAction {
  for (let i = 0; i < attempts; i++) {
    const generator = BY_NAME.get(ctx.pick(WEIGHTED_NAMES));
    const action = generator?.build(ctx, state);
    if (action) return action;
  }
  const data = randomSectionData(ctx);
  const shots = data.shots as unknown[];
  return { action: 'createSection', args: [data], label: `createSection(shots=${shots.length})` };
}
