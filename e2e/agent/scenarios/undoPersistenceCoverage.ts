/**
 * The COVERAGE PLAN for `undo-persistence-fuzz`: a fixed sequence of mutations
 * chosen so that every UndoData variant the live app can actually produce is
 * present on the undo stack when the run crosses the save/reload boundary.
 *
 * ## Why a plan and not a random draw
 *
 * `undo-redo-fuzz` draws its mutations at random, which is right for finding
 * unexpected interactions but wrong for a scenario whose hypothesis is "bug 8's
 * mechanism afflicts every id-bearing variant". A random stream reaches a given
 * variant by luck and a short run may miss several, so the coverage claim would
 * be unfalsifiable. Here the ORDER and the SET are fixed; only the targets and
 * the values are drawn from `ctx.rng()`, so different seeds still exercise
 * different sections, stations, geometry and text while every run makes the same
 * coverage promise. The scenario then re-reads `get_undo_stack` and ASSERTS the
 * promised variants are really there.
 *
 * ## Which variants the app can actually produce
 *
 * `AppState::generate_undo_data` / `finalize_undo_data`
 * (src-tauri/src/core/state/undo_capture.rs) plus the three paths that push
 * their own entry (`execute_batch`, `execute_move_comment`,
 * `repair_open_project_integrity`) are the ONLY producers. Measured against
 * them, six `UndoData` variants are dead as far as a freshly-stripped project is
 * concerned - see `UNREACHABLE_VARIANTS`. They survive in `undo()` as restore
 * arms for entries persisted by older builds, so a scenario that strips the
 * fixture's history can never construct one.
 *
 * ## The variant map
 *
 * `get_undo_stack` gives the frontend a `commandType` (the snake_case `Command`
 * name, `commands/history.rs::get_command_type`) and a description, never the
 * `UndoData` variant. So the mapping below is transcribed from
 * `undo_capture.rs`, one row per command, and is the thing to re-check when that
 * file changes.
 */
import type { ScenarioContext } from './framework';
import type { TargetingDigest } from '../lib/fuzzOracleCore';

/**
 * `src-tauri/src/models/id_stride.rs`. The loader renumbers every shot to
 * `section_id * FEATURE_ID_STRIDE + sequence_order`
 * (persistence/sqlite/read.rs), and the in-session allocator hands out ids from
 * the same space - which is why a stale persisted id COLLIDES rather than
 * missing. Mirrored here so the scenario can prove, before it saves, that the
 * ids it is about to persist really have diverged from positional order.
 */
export const FEATURE_ID_STRIDE = 100_000;

/** The `UndoData` variants a live command can produce. */
export type UndoVariant =
  | 'CreatedSectionSnapshot'
  | 'CreatedShotSnapshot'
  | 'PreviousValues(shot)'
  | 'PreviousValues(section)'
  | 'InverseCommand'
  | 'ClosureInfo'
  | 'ZeroDatumInfo'
  | 'SegmentMoveInfo'
  | 'ProjectSnapshotPair';

/**
 * `UndoHistoryItem.commandType` -> the `UndoData` variant that command's entry
 * carries. Transcribed from `undo_capture.rs`; every row is a `match` arm there.
 *
 * Two rows are conditional in the Rust and unconditional here, deliberately:
 *
 *   - `create_loop_closure` produces `ClosureInfo` for `Move` /
 *     `LeastSquaresWeighted` and a `ProjectSnapshotPair` for
 *     `ProportionalByLength` / `EqualDistribution` - but those two strategies are
 *     rejected outright by `Project::create_loop_closure`
 *     (models/project/mutations.rs "Closure distribution strategies are
 *     deferred"), so no entry is ever pushed for them. The plan only ever asks
 *     for `Move`.
 *   - `reverse_section` produces a `ProjectSnapshotPair` only for a section with
 *     shots; a shot-less section reverses to itself and pushes nothing at all
 *     (so no row is created to be mapped). The plan only ever reverses a
 *     populated section.
 */
export const VARIANT_BY_COMMAND_TYPE: Readonly<Record<string, UndoVariant>> = {
  create_section: 'CreatedSectionSnapshot',
  create_shot: 'CreatedShotSnapshot',
  update_shot: 'PreviousValues(shot)',
  update_section_metadata: 'PreviousValues(section)',
  set_shot_kind: 'InverseCommand',
  set_station_comment: 'InverseCommand',
  create_loop_closure: 'ClosureInfo',
  remove_loop_closure: 'ClosureInfo',
  set_zero_datum: 'ZeroDatumInfo',
  remove_zero_datum: 'ZeroDatumInfo',
  move_section: 'SegmentMoveInfo',
  move_segment: 'SegmentMoveInfo',
  delete_section: 'ProjectSnapshotPair',
  delete_shot: 'ProjectSnapshotPair',
  reverse_section: 'ProjectSnapshotPair',
  merge_stations: 'ProjectSnapshotPair',
  unmerge_stations: 'ProjectSnapshotPair',
  unmerge_station_pair: 'ProjectSnapshotPair',
  move_station: 'ProjectSnapshotPair',
  move_comment: 'ProjectSnapshotPair',
  batch: 'ProjectSnapshotPair',
  repair_integrity: 'ProjectSnapshotPair',
};

/**
 * `UndoData` variants that exist in `src-tauri/src/core/undo.rs` and have a
 * restore arm in `undo()`/`redo()`, but which NO live command produces any more.
 *
 * Verified by grepping every construction site outside `#[cfg(test)]`: only
 * `undo_capture.rs` and `app_state.rs` build `UndoData`, and between them they
 * emit exactly the nine variants above plus `None`. Each name below was replaced
 * by a `ProjectSnapshotPair` (the capture comments in `undo_capture.rs` say why:
 * a lightweight record could not restore the cascades the command triggers) or,
 * for `ShotSnapshot`, is documented in `undo()` as serving "legacy persisted
 * entries" only.
 *
 * This matters for the scope of this scenario: a stale-id defect in one of these
 * arms is unreachable from a project whose persisted history was stripped, so
 * the hunt is bounded by this list rather than by the enum.
 */
export const UNREACHABLE_VARIANTS: Readonly<Record<string, string>> = {
  MergeInfo: 'MergeStations captures a ProjectSnapshotPair instead (undo_capture.rs)',
  UnmergeInfo: 'UnmergeStations/UnmergeStationPair capture a ProjectSnapshotPair instead',
  StationMoveInfo: 'MoveStation captures a ProjectSnapshotPair instead',
  ShotSnapshot: 'DeleteShot captures a ProjectSnapshotPair; this arm serves legacy persisted entries',
  SectionSnapshot: 'DeleteSection captures a ProjectSnapshotPair; no live producer',
  ProjectSnapshot: 'superseded by ProjectSnapshotPair; no live producer',
};

/** One `projectStore` action plus its args, exactly as the bridge dispatches it. */
export interface CoverageAction {
  action: string;
  args: unknown[];
  /** Short label for the action history in a failure message. */
  label: string;
}

/** State the plan carries between its steps. */
export interface CoverageMemo {
  /**
   * The section `createSection` made, and the target of every shot-level step.
   *
   * Deliberately a FRESH section rather than one of the fixture's: it is
   * disconnected, has no zero datum and is in no loop, so `delete_shot`'s
   * "part of a loop / anchored to a zero datum" guard cannot refuse the undo of
   * a shot insert. That guard is open bug 6, an in-session defect this scenario
   * is not hunting, and letting it fire here would wedge the history before the
   * persistence walk ever started.
   */
  createdSectionId: number | null;
  /** Section ids present before `createSection` ran, so the new one is identifiable. */
  sectionIdsBefore: number[];
  /** Closure ids present before the plan's `createLoopClosure` step. */
  closureIdsBefore: number[];
}

export function newCoverageMemo(): CoverageMemo {
  return { createdSectionId: null, sectionIdsBefore: [], closureIdsBefore: [] };
}

export interface CoverageStep {
  /** Stable name; used in metrics (`step:<name>`) and the action history. */
  name: string;
  /** The variant this step exists to put on the stack. */
  variant: UndoVariant;
  /**
   * True when NO fixture topology can refuse this step. A guaranteed step that
   * pushes no entry is a bug in the plan and fails the scenario; a
   * topology-dependent one is logged and counted instead.
   */
  guaranteed: boolean;
  /** Why the step is here, one line, shown in the coverage report. */
  purpose: string;
  build(ctx: ScenarioContext, digest: TargetingDigest, memo: CoverageMemo): CoverageAction | null;
}

// ---------------------------------------------------------------------------
// Value generators. Deliberately NOT shared with `undoRedoFuzzActions.ts`.
//
// That module's generators are boundary-biased on purpose (empty strings, 1e3 m
// displacements, zero-length shots), which is exactly right for a scenario whose
// job is to find input-shaped failures. Here every step MUST succeed, because a
// refused step is a hole in the coverage claim, so the ranges below are nominal
// and well inside every validator. Keeping them local also means this scenario
// can never perturb the main fuzzer's draw stream or its documented repro seeds.
// ---------------------------------------------------------------------------

const COLORS = ['#3388FF', '#FF8833', '#33CC66', '#CC33AA', '#FFCC00', '#6666FF'] as const;
const SHOT_KINDS = ['Normal', 'Jump', 'Reference'] as const;
const SURVEY_DIRECTIONS = ['in', 'out'] as const;

function rounded(ctx: ScenarioContext, min: number, max: number, decimals: number): number {
  return Number((min + ctx.rng() * (max - min)).toFixed(decimals));
}

/** A valid, unremarkable `ShotData` (every field present). */
export function nominalShot(ctx: ScenarioContext): Record<string, unknown> {
  const azimuth = rounded(ctx, 0, 359.9, 1);
  const depthIn = rounded(ctx, 0, 30, 2);
  return {
    azimuth_in: azimuth,
    azimuth_out: Number(((azimuth + rounded(ctx, -1.5, 1.5, 1) + 360) % 360).toFixed(1)),
    length: rounded(ctx, 1, 12, 2),
    depth_in: depthIn,
    depth_out: Number(Math.max(0, depthIn + rounded(ctx, -3, 3, 2)).toFixed(2)),
    pitch_in: null,
    pitch_out: null,
    left: rounded(ctx, 0.1, 4, 2),
    right: rounded(ctx, 0.1, 4, 2),
    up: rounded(ctx, 0.1, 4, 2),
    down: rounded(ctx, 0.1, 4, 2),
    comment: null,
    kind: 'Normal',
    marker_index: null,
    temperature: null,
  };
}

/** A valid `SectionData` with 3 shots (enough for a mid-section insert AND a delete). */
function nominalSection(ctx: ScenarioContext): Record<string, unknown> {
  return {
    name: `persist-${ctx.randInt(1000, 9999)}`,
    surveyor: `persist-surveyor-${ctx.randInt(1, 9)}`,
    date: `20${ctx.randInt(10, 26)}-0${ctx.randInt(1, 9)}-1${ctx.randInt(0, 9)}`,
    color: ctx.pick(COLORS),
    direction: ctx.pick(SURVEY_DIRECTIONS),
    quality: ctx.randInt(1, 5),
    shots: [nominalShot(ctx), nominalShot(ctx), nominalShot(ctx)],
  };
}

function nominalOffset(ctx: ScenarioContext): Record<string, number> {
  return {
    x: rounded(ctx, -3, 3, 3),
    y: rounded(ctx, -3, 3, 3),
    z: rounded(ctx, -1.5, 1.5, 3),
  };
}

/** Sections by ascending id, so a pick never depends on `Vec` order. */
function sortedSections(digest: TargetingDigest): [number, number[]][] {
  return [...digest.s].sort((a, b) => a[0] - b[0]);
}

function shotsOf(digest: TargetingDigest, sectionId: number): number[] {
  const found = digest.s.find((entry) => entry[0] === sectionId);
  return found ? [...found[1]] : [];
}

/** Station refs inside one section, ascending by index. */
function stationsOf(digest: TargetingDigest, sectionId: number): number[] {
  return digest.st
    .filter((ref) => ref[0] === sectionId)
    .map((ref) => ref[1])
    .sort((a, b) => a - b);
}

function toRef(sectionId: number, stationIndex: number): Record<string, number> {
  return { section_id: sectionId, station_index: stationIndex };
}

/** The created section, or null when `createSection` did not land. */
function target(memo: CoverageMemo): number | null {
  return memo.createdSectionId;
}

// ---------------------------------------------------------------------------
// The plan. Order is load-bearing:
//
//   1-6   build the shot-level history INSIDE the fresh section, and with it the
//         id-vs-position divergence bug 8 needs. All of it happens while that
//         section is still disconnected, so no delete guard can refuse an undo.
//   7-12  section-level and geometry entries.
//   13-17 the graph entries. The merge comes before the closure because
//         `create_loop_closure` refuses an unconnected pair, and the whole graph
//         block comes last so the unwind takes it apart before touching the
//         shots.
// ---------------------------------------------------------------------------

export const COVERAGE_STEPS: readonly CoverageStep[] = [
  {
    name: 'createSection',
    variant: 'CreatedSectionSnapshot',
    guaranteed: true,
    purpose: 'CreatedSectionSnapshot { section_id, section_data }, and the fresh target section',
    build(ctx, digest, memo) {
      memo.sectionIdsBefore = sortedSections(digest).map((entry) => entry[0]);
      const data = nominalSection(ctx);
      return { action: 'createSection', args: [data], label: 'createSection(shots=3)' };
    },
  },
  {
    name: 'createShotBefore',
    variant: 'CreatedShotSnapshot',
    guaranteed: true,
    purpose:
      'CreatedShotSnapshot with a BEFORE anchor: the id comes from the allocator while the ' +
      'position is 0, so ids stop matching positional order - bug 8s precondition',
    build(ctx, digest, memo) {
      const sectionId = target(memo);
      if (sectionId === null) return null;
      const shotIds = shotsOf(digest, sectionId).sort((a, b) => a - b);
      const beforeId = shotIds[0];
      if (beforeId === undefined) return null;
      return {
        action: 'createShot',
        args: [sectionId, nominalShot(ctx), null, beforeId],
        label: `createShot(s=${sectionId},before=${beforeId})`,
      };
    },
  },
  {
    name: 'createShotAfter',
    variant: 'CreatedShotSnapshot',
    guaranteed: true,
    purpose: 'CreatedShotSnapshot with an AFTER anchor (the other redo path in undo.rs)',
    build(ctx, digest, memo) {
      const sectionId = target(memo);
      if (sectionId === null) return null;
      const shotIds = shotsOf(digest, sectionId).sort((a, b) => a - b);
      const afterId = shotIds[Math.floor(shotIds.length / 2)];
      if (afterId === undefined) return null;
      return {
        action: 'createShot',
        args: [sectionId, nominalShot(ctx), afterId],
        label: `createShot(s=${sectionId},after=${afterId})`,
      };
    },
  },
  {
    name: 'deleteShotMid',
    variant: 'ProjectSnapshotPair',
    guaranteed: true,
    purpose: 'a mid-section delete: widens the id-vs-position gap and takes the DeleteShot pair path',
    build(ctx, digest, memo) {
      const sectionId = target(memo);
      if (sectionId === null) return null;
      const shotIds = shotsOf(digest, sectionId);
      if (shotIds.length < 3) return null;
      // A middle shot, never an end one: removing an end shot leaves the
      // remaining ids in positional order again on one side.
      const shotId = shotIds[1 + ctx.randInt(0, shotIds.length - 3)];
      if (shotId === undefined) return null;
      return {
        action: 'deleteShot',
        args: [sectionId, shotId],
        label: `deleteShot(s=${sectionId},shot=${shotId})`,
      };
    },
  },
  {
    name: 'updateShot',
    variant: 'PreviousValues(shot)',
    guaranteed: true,
    purpose:
      'PreviousValues { section_id, shot_id: Some(..) } on the DIVERGED section: undo calls ' +
      'update_shot(section, stale_id) and redo re-executes Command::UpdateShot with the same id',
    build(ctx, digest, memo) {
      const sectionId = target(memo);
      if (sectionId === null) return null;
      const shotIds = shotsOf(digest, sectionId).sort((a, b) => a - b);
      const shotId = shotIds[ctx.randInt(0, shotIds.length - 1)];
      if (shotId === undefined) return null;
      return {
        action: 'updateShot',
        args: [
          sectionId,
          shotId,
          { length: rounded(ctx, 1, 15, 2), azimuth_in: rounded(ctx, 0, 359.9, 1) },
        ],
        label: `updateShot(s=${sectionId},shot=${shotId})`,
      };
    },
  },
  {
    name: 'setShotKind',
    variant: 'InverseCommand',
    guaranteed: true,
    purpose:
      'InverseCommand(SetShotKind { shot_id }) on the DIVERGED section: both the undo and the ' +
      'redo re-execute a Command that names the shot by id',
    build(ctx, digest, memo) {
      const sectionId = target(memo);
      if (sectionId === null) return null;
      const shotIds = shotsOf(digest, sectionId).sort((a, b) => a - b);
      const shotId = shotIds[ctx.randInt(0, shotIds.length - 1)];
      if (shotId === undefined) return null;
      const kind = ctx.pick(SHOT_KINDS);
      return {
        action: 'setShotKind',
        args: [sectionId, shotId, kind],
        label: `setShotKind(s=${sectionId},shot=${shotId},${kind})`,
      };
    },
  },
  {
    name: 'updateSection',
    variant: 'PreviousValues(section)',
    guaranteed: true,
    purpose: 'PreviousValues { section_id, shot_id: None }',
    build(ctx, digest, memo) {
      const sectionId = target(memo);
      if (sectionId === null) return null;
      // Only the three NON-NULLABLE fields. `name` / `surveyor` / `date` are
      // open bug 5 (SectionUpdates has no double_option, so undo cannot restore
      // a previously-null value) - an in-session defect that is already pinned
      // red and is not what this scenario hunts. Patching it here would make
      // every iteration fail on bug 5 before the persistence walk started. This
      // is input selection, not a relaxed oracle: an unexpected change to any of
      // those three fields still fails.
      return {
        action: 'updateSection',
        args: [
          sectionId,
          {
            color: ctx.pick(COLORS),
            direction: ctx.pick(SURVEY_DIRECTIONS),
            quality: ctx.randInt(1, 5),
          },
        ],
        label: `updateSection(s=${sectionId},color/direction/quality)`,
      };
    },
  },
  {
    name: 'updateStationComment',
    variant: 'InverseCommand',
    guaranteed: true,
    purpose: 'InverseCommand(SetStationComment { station_ref }) - a positional ref, not an id',
    build(ctx, digest, memo) {
      const sectionId = target(memo);
      if (sectionId === null) return null;
      const stations = stationsOf(digest, sectionId);
      const index = stations[ctx.randInt(0, stations.length - 1)];
      if (index === undefined) return null;
      return {
        action: 'updateStationComment',
        args: [toRef(sectionId, index), `persist-station-${ctx.randInt(0, 9999)}`],
        label: `updateStationComment(${sectionId}/${index})`,
      };
    },
  },
  {
    name: 'moveSection',
    variant: 'SegmentMoveInfo',
    guaranteed: true,
    purpose: 'SegmentMoveInfo { affected_sections, previous_offsets } - section ids, which DO persist',
    build(ctx, digest, memo) {
      const sectionId = target(memo);
      if (sectionId === null) return null;
      return {
        action: 'moveSection',
        args: [sectionId, nominalOffset(ctx)],
        label: `moveSection(s=${sectionId})`,
      };
    },
  },
  {
    name: 'moveStation',
    variant: 'ProjectSnapshotPair',
    guaranteed: true,
    purpose:
      'a ProjectSnapshotPair recorded BEFORE the save: undoing or redoing it restores a whole ' +
      'pre-save project, which is finding 11s mechanism and also puts the PRE-RENUMBER shot ids ' +
      'back into a project the entries above it were captured against',
    build(ctx, digest, memo) {
      const sectionId = target(memo);
      if (sectionId === null) return null;
      const stations = stationsOf(digest, sectionId);
      const index = stations[ctx.randInt(0, stations.length - 1)];
      if (index === undefined) return null;
      return {
        action: 'moveStation',
        args: [toRef(sectionId, index), nominalOffset(ctx)],
        label: `moveStation(${sectionId}/${index})`,
      };
    },
  },
  {
    name: 'reverseSection',
    variant: 'ProjectSnapshotPair',
    guaranteed: true,
    purpose: 'the ReverseSection pair path, and it re-orders the diverged section once more',
    build(ctx, digest, memo) {
      const sectionId = target(memo);
      if (sectionId === null) return null;
      if (shotsOf(digest, sectionId).length === 0) return null;
      const swap = ctx.rng() < 0.5;
      return {
        action: 'reverseSection',
        args: [sectionId, swap],
        label: `reverseSection(s=${sectionId},swapLR=${swap})`,
      };
    },
  },
  {
    name: 'executeBatch',
    variant: 'ProjectSnapshotPair',
    guaranteed: true,
    purpose: 'one entry covering several sub-commands (execute_batch pushes its own pair)',
    build(ctx, digest, memo) {
      const sectionId = target(memo);
      if (sectionId === null) return null;
      const shotIds = shotsOf(digest, sectionId).sort((a, b) => a - b);
      const shotId = shotIds[ctx.randInt(0, shotIds.length - 1)];
      if (shotId === undefined) return null;
      return {
        action: 'executeBatch',
        args: [
          [
            {
              type: 'update_shot',
              section_id: sectionId,
              shot_id: shotId,
              updates: { length: rounded(ctx, 1, 15, 2) },
            },
            { type: 'move_section', section_id: sectionId, offset: nominalOffset(ctx) },
          ],
        ],
        label: `executeBatch(updShot+mvSec,s=${sectionId})`,
      };
    },
  },
  {
    name: 'zeroDatum',
    variant: 'ZeroDatumInfo',
    guaranteed: true,
    purpose:
      'ZeroDatumInfo { station_ref, previous_gps, previous_offsets }. Adaptive: a fixture that ' +
      'already has datums (naharon) gets a REMOVE, one that has none (fractal) gets a SET, so ' +
      'the variant is reached on both without tripping the one-datum-per-component guard',
    build(ctx, digest, memo) {
      const existing = [...digest.z].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const first = existing[0];
      if (first !== undefined) {
        return {
          action: 'removeZeroDatum',
          args: [toRef(first[0], first[1])],
          label: `removeZeroDatum(${first[0]}/${first[1]})`,
        };
      }
      const sectionId = target(memo);
      if (sectionId === null) return null;
      const gps = {
        latitude: rounded(ctx, 20.2, 20.5, 6),
        longitude: rounded(ctx, -87.5, -87.2, 6),
        depth_reference: rounded(ctx, 0, 5, 2),
      };
      return {
        action: 'setZeroDatum',
        args: [toRef(sectionId, 0), gps, { fitToBounds: false }],
        label: `setZeroDatum(${sectionId}/0)`,
      };
    },
  },
  {
    name: 'mergeStations',
    variant: 'ProjectSnapshotPair',
    guaranteed: true,
    purpose:
      'the MergeStations pair path, and the connectivity createLoopClosure needs. One side is ' +
      'always the FRESH section, so "stations are already connected" cannot refuse it',
    build(ctx, digest, memo) {
      const sectionId = target(memo);
      if (sectionId === null) return null;
      const own = stationsOf(digest, sectionId);
      const ownIndex = own[own.length - 1];
      const others = sortedSections(digest).filter(
        (entry) => entry[0] !== sectionId && entry[1].length > 0,
      );
      const other = others[ctx.randInt(0, others.length - 1)];
      if (ownIndex === undefined || other === undefined) return null;
      const otherStations = stationsOf(digest, other[0]);
      const otherIndex = otherStations[ctx.randInt(0, otherStations.length - 1)];
      if (otherIndex === undefined) return null;
      return {
        action: 'mergeStations',
        args: [toRef(sectionId, ownIndex), toRef(other[0], otherIndex)],
        label: `mergeStations(${sectionId}/${ownIndex},${other[0]}/${otherIndex})`,
      };
    },
  },
  {
    name: 'createLoopClosure',
    variant: 'ClosureInfo',
    guaranteed: false,
    purpose:
      'ClosureInfo from the CREATE side. Topology-dependent: the merge above supplies the ' +
      'connectivity, but the pair must also be unmerged and not already closed',
    build(ctx, digest, memo) {
      memo.closureIdsBefore = [...digest.c].sort((a, b) => a - b);
      const sectionId = target(memo);
      if (sectionId === null) return null;
      const own = stationsOf(digest, sectionId);
      // Station 0 of the fresh section: the merge above used its LAST station,
      // so this pair is connected but not itself merged.
      const ownIndex = own[0];
      const merged = [...digest.m].sort(
        (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3],
      );
      const link = merged.find((entry) => entry[0] === sectionId || entry[2] === sectionId);
      if (ownIndex === undefined || link === undefined) return null;
      const otherSection = link[0] === sectionId ? link[2] : link[0];
      const otherMergedIndex = link[0] === sectionId ? link[3] : link[1];
      const otherStations = stationsOf(digest, otherSection).filter(
        (index) => index !== otherMergedIndex,
      );
      const otherIndex = otherStations[ctx.randInt(0, otherStations.length - 1)];
      if (otherIndex === undefined) return null;
      return {
        action: 'createLoopClosure',
        args: [toRef(sectionId, ownIndex), toRef(otherSection, otherIndex), 'Move'],
        label: `createLoopClosure(${sectionId}/${ownIndex},${otherSection}/${otherIndex})`,
      };
    },
  },
  {
    name: 'removeLoopClosure',
    variant: 'ClosureInfo',
    guaranteed: false,
    purpose:
      'ClosureInfo from the REMOVE side (a different arm of the same match in undo.rs). ' +
      'Topology-dependent: it needs a closure to exist, which is either the one above or one ' +
      'the fixture shipped',
    build(ctx, digest) {
      const ids = [...digest.c].sort((a, b) => a - b);
      const id = ids[ctx.randInt(0, ids.length - 1)];
      if (id === undefined) return null;
      return { action: 'removeLoopClosure', args: [id], label: `removeLoopClosure(${id})` };
    },
  },
];

/** Every variant the plan promises, in first-appearance order. */
export const PLANNED_VARIANTS: readonly UndoVariant[] = [
  ...new Set(COVERAGE_STEPS.map((step) => step.variant)),
];

/** Variants a guaranteed step promises; a run missing one of these has a broken plan. */
export const GUARANTEED_VARIANTS: readonly UndoVariant[] = [
  ...new Set(COVERAGE_STEPS.filter((step) => step.guaranteed).map((step) => step.variant)),
];

/**
 * True when `shotIds` no longer equals what the LOADER would renumber them to.
 *
 * `section_id * FEATURE_ID_STRIDE + sequence_order` is both what
 * `persistence/sqlite/read.rs` writes on load and where the in-session allocator
 * draws from, so ids that still match positional order would survive a reload
 * unchanged and a stale persisted id would address the same shot it always did.
 * The divergence is the whole precondition, so the scenario asserts it rather
 * than assuming the plan produced it.
 */
export function idsDivergeFromPosition(sectionId: number, shotIds: readonly number[]): boolean {
  return shotIds.some((id, index) => id !== sectionId * FEATURE_ID_STRIDE + index);
}
