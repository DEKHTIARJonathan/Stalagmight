/**
 * v3: the IMPORT half of the `undo-redo-fuzz` action space.
 *
 * Every generator here is `since: 'v3'`, so it is drawn ONLY when
 * `STALAGMIGHT_FUZZ_STREAM=v3`. That is the whole compatibility story: under v1
 * and v2 `weightedNamesFor` filters this group out before the weighted name
 * array is built, no helper below is ever called, and nothing here consumes a
 * draw - so every repro line in `undoRedoFuzz.ts`'s header still replays bit for
 * bit. Same discipline v2 followed when it was added on top of v1.
 *
 * ## Why imports belong under the undo/redo oracle at all
 *
 * `import_sections` and the four `execute_*_import` commands push ONE undo entry
 * covering an arbitrary number of new sections, placements, station comments and
 * (for `import_sections`) in-place edits to shots that were already there. That
 * is the widest single command in the app, and it is a `ProjectSnapshotPair` -
 * the entry family findings 8 and 11 both lived in. The per-depth snapshot oracle
 * this scenario already runs is exactly the instrument for it: an import whose
 * undo does not restore the project it replaced fails at the next comparison,
 * whatever the format it came from.
 *
 * The weights keep this group a MINORITY of the draws (about 22% of the balanced
 * total). The scenario's value is undo/redo over mutations; imports are an
 * addition to that space, not a new centre of gravity.
 *
 * ## The three payload shapes, and what each one is FOR
 *
 * 1. `importSectionsSynthetic` - fully synthetic `ImportSectionConfig` batches:
 *    0..6 sections, boundary geometry, duplicate names inside one batch, all six
 *    `ImportPlacement` variants (including refs the digest says are NOT live -
 *    the shape a placement takes when it names a section the run has since
 *    deleted), `reverse`, `station_comments` and all three `VirtualShotMode`s.
 * 2. `importSectionsNonFinite` - the same, with one guarded field poisoned.
 * 3. `importSectionsWithOverlap` - `existing_shot_updates`, the DMP wizard's
 *    overlap interpolation, driven straight at the command.
 *
 * ## What "non-finite" actually reaches Rust, and why that is the right test
 *
 * A `NaN` or an `Infinity` NEVER arrives as such. `JSON.stringify` spells both
 * `null`, and that applies identically to the WebDriver bridge these args cross
 * and to the real `invoke` the wizard calls - which is the entire premise of
 * `src/utils/importPayloadGuard.ts` ("it serializes to `null`, and Rust's serde
 * rejects the whole batch with an error that names no section, no row and no
 * field"). So what this generator tests is the receiving end of that guard:
 *
 *   - A REQUIRED number (`length`, `azimuth_in`, `azimuth_out`, `depth_in`,
 *     `depth_out`) is `f64` in `ShotData`. `null` fails Tauri's argument
 *     deserialization, the command never runs, and the store action REJECTS.
 *   - An OPTIONAL number (`pitch_in`, `left`, ...) is `Option<f64>`, so `null`
 *     deserializes as "absent" and the import SUCCEEDS with the value silently
 *     dropped. That is precisely why the frontend guard refuses those too, and
 *     it is not a backend defect - so this generator does not claim a rejection
 *     for it.
 *
 * `mustBeRejected` encodes that split, and it is a pure function of the recorded
 * args so a REPLAY re-derives the same expectation from the trace.
 *
 * ## File-backed imports and the replay contract
 *
 * `executeTmlImport`, `executeCompassImport`, `executeWallsImport`,
 * `executeGpxImport` and the parse-only `importDmp` all take a PATH. A generator
 * cannot write files (it is called for candidates that may be discarded, and it
 * must stay pure so the shrinker can re-derive a step), so it returns the SPEC
 * plus a session-relative `rel`, and `undoRedoFuzz.ts` materializes it right
 * before dispatch:
 *
 *   1. the generator draws a `GeneratedFileSpec` (reusing `surveyFileSpecs.ts` /
 *      `surveyFileCorrupt.ts` - wave 1 and wave 3's writers, never a fixture),
 *      names the file content-addressedly, and sets
 *      `args[0] = 'fuzz-files/<name>'`;
 *   2. the scenario records a `genFile` trace step carrying the SPEC, writes the
 *      file, and swaps `args[0]` for the absolute path for this run only;
 *   3. a replay re-materializes from the recorded spec and re-resolves `args[0]`
 *      against ITS OWN files directory.
 *
 * The trace therefore holds no absolute path and no file bytes - the repo
 * forbids committing fixtures, and a trace is meant to be attachable to a bug
 * report. `FILE_ARG_ACTIONS` (in `lib/fuzzTrace.ts`) is the single list of
 * actions whose `args[0]` is a path; `validateStep` refuses a trace that hands
 * one of them an absolute or escaping path, for the same reason `rel` is checked
 * on every other v2 step kind.
 *
 * ## What is deliberately NOT here
 *
 * `suggest_orphan_placements` is NOT a `projectStore` action - `App.tsx` and the
 * three import dialogs call it through `invokeIpc` directly, and this scenario
 * dispatches store actions by name. Adding an IPC-by-name path to the bridge
 * would widen what a recorded trace can reach for one read-only probe, which is
 * not a trade worth making; the probe is covered by `import-dialog-fuzz`, which
 * drives the dialogs that call it.
 */
import type { ScenarioContext } from './framework';
import type { TargetingDigest } from '../lib/fuzzOracleCore';
import {
  COLORS,
  SHOT_KINDS,
  SURVEY_DIRECTIONS,
  biasedText,
  chance,
  pickShot,
  pickStationRef,
  randomShotData,
  roundedFloat,
  sortedSections,
  toRef,
  type ActionGenerator,
} from './undoRedoFuzzActions';
import { malformedProbability } from './importDialogGenerators';
import {
  randomSurveyFileSpec,
  type GeneratedFileSpec,
  type SurveyFileFormat,
} from '../lib/surveyFileSpecs';
import { corruptSpec } from '../lib/surveyFileCorrupt';

/**
 * Directory, relative to the run's own file root, that generated inputs live in.
 *
 * Every `args[0]` a file-backed generator produces is `<this>/<content-hash>.<ext>`,
 * which is what makes it session-relative in the trace and re-resolvable on a
 * replay. Same name the other import fuzzers use, so a reader recognises it.
 */
export const FUZZ_FILES_REL = 'fuzz-files';

/** The three `VirtualShotMode`s (`src/types/ipc/VirtualShotMode.ts`). */
const VIRTUAL_SHOT_MODES = ['Auto', 'AllJumps', 'AllReferences'] as const;

/**
 * Formats a file-backed generator may draw, per family.
 *
 * The two PROJECT formats (`.mak`, `.wpj`) are included: neither is self
 * contained, `materializeSurveyFile` writes their siblings, and a project file
 * is the only way to reach the multi-survey import path. They are drawn less
 * often than the single-file spellings simply because they cost more to write.
 */
const TML_FORMATS: readonly SurveyFileFormat[] = ['tml', 'tmlu'];
const COMPASS_FORMATS: readonly SurveyFileFormat[] = ['dat', 'dat', 'mak'];
const WALLS_FORMATS: readonly SurveyFileFormat[] = ['srv', 'srv', 'wpj'];

/**
 * Cap on the shots one `importSections` call may carry, across every section.
 *
 * Not a style choice: the canonical snapshot is re-serialized and compared at
 * EVERY step, so a run that imports 400 shots pays for them on every remaining
 * iteration. Sections stay cheap and numerous instead, which is the axis that
 * finds placement and undo bugs.
 */
const MAX_IMPORT_SHOTS = 24;

/** Sections one synthetic batch may carry. Zero is a deliberate boundary. */
const MAX_IMPORT_SECTIONS = 6;

/**
 * Required `ShotData` numbers - `f64` in Rust, so `null` fails deserialization
 * and the whole command is refused before it runs. Mirrors `REQUIRED_NUMBERS` in
 * `src/utils/importPayloadGuard.ts`.
 */
const REQUIRED_SHOT_NUMBERS = [
  'length',
  'azimuth_in',
  'azimuth_out',
  'depth_in',
  'depth_out',
] as const;

/**
 * Optional `ShotData` numbers - `Option<f64>`, so `null` is "absent" and the
 * import succeeds having silently dropped the value. Poisoning one is a
 * COVERAGE case, never a rejection claim.
 */
const OPTIONAL_SHOT_NUMBERS = ['pitch_in', 'pitch_out', 'left', 'right', 'up', 'down'] as const;

/** Numeric fields an `ExistingShotUpdate` patch may carry. */
const UPDATE_NUMBER_FIELDS = [
  'azimuth_in',
  'azimuth_out',
  'length',
  'depth_in',
  'depth_out',
] as const;

/** A 64-hex string in the shape `calculate_file_hash` returns. */
function fakeHash(ctx: ScenarioContext): string {
  let out = '';
  for (let i = 0; i < 64; i++) out += '0123456789abcdef'[ctx.randInt(0, 15)];
  return out;
}

/**
 * A date the way `ImportSectionConfig` wants it, or one of the two shapes that
 * are not.
 *
 * `null` is legal and means "no date". `''` is NOT: `date` is
 * `Option<NaiveDate>` and chrono parses an empty string as `TOO_SHORT`, whose
 * Display is literally `premature end of input` - the whole `import_sections`
 * call then fails at Tauri's argument layer. That was issue #478, found through
 * the wizard; drawing it here asserts the same refusal on the route that
 * BYPASSES the wizard's normalisation.
 */
function drawDate(ctx: ScenarioContext): string | null {
  const roll = ctx.rng();
  if (roll < 0.1) return null;
  if (roll < 0.16) return '';
  if (roll < 0.2) return `20${ctx.randInt(10, 26)}-13-4${ctx.randInt(0, 9)}`;
  return `20${ctx.randInt(10, 26)}-0${ctx.randInt(1, 9)}-1${ctx.randInt(0, 9)}`;
}

/**
 * A `StationRef` the digest says is NOT live.
 *
 * The interesting placement target is a station that WAS there: a section the
 * run deleted two moves ago, or a station index past the end of a section a
 * range-delete shortened. Both are ids in exactly this shape - plausible,
 * addressable, and no longer resolvable - and the import must refuse or ignore
 * them rather than place a section against nothing.
 */
function staleRef(ctx: ScenarioContext, state: TargetingDigest): StationRefShape {
  const sections = sortedSections(state);
  if (sections.length === 0 || chance(ctx, 0.3)) {
    const highest = sections.reduce((max, section) => Math.max(max, section[0]), 0);
    return { section_id: highest + ctx.randInt(1, 40), station_index: ctx.randInt(0, 5) };
  }
  const section = ctx.pick(sections);
  // Station count is shots + 1, so anything at or above that is off the end.
  return {
    section_id: section[0],
    station_index: section[1].length + 1 + ctx.randInt(0, 8),
  };
}

/** Mirrors `src/types/ipc/StationRef.ts`. Restated, never imported - see the actions header. */
interface StationRefShape {
  section_id: number;
  station_index: number;
}

/** A `Coordinates` (`{x, y, z}`), with the boundary values weighted in. */
function drawCoordinates(ctx: ScenarioContext): Record<string, number> {
  const axis = (): number => (chance(ctx, 0.15) ? ctx.pick([0, -0.0001, 1e3, -1e3, 1e-9]) : roundedFloat(ctx, -8, 8, 3));
  return { x: axis(), y: axis(), z: axis() };
}

/**
 * One `ImportPlacement`, drawn across all six variants
 * (`src/types/ipc/ImportPlacement.ts`).
 *
 * `sectionIndex` is this config's own index in the batch and `stationCount` its
 * station count, so `from_importing` can name a SIBLING in the same batch (the
 * import-to-import case) and every `*_station` index can be drawn both in range
 * and out of it.
 */
function drawPlacement(
  ctx: ScenarioContext,
  state: TargetingDigest,
  sectionIndex: number,
  stationCount: number,
): { placement: Record<string, unknown>; label: string } {
  const station = (): number => (chance(ctx, 0.25) ? ctx.randInt(stationCount, stationCount + 6) : ctx.randInt(0, Math.max(0, stationCount - 1)));
  const target = (): StationRefShape => {
    if (chance(ctx, 0.35)) return staleRef(ctx, state);
    const ref = pickStationRef(ctx, state);
    return ref ? toRef(ref) : staleRef(ctx, state);
  };
  const kind = ctx.pick([
    'origin',
    'origin',
    'zero_datum',
    'from_existing',
    'from_existing',
    'from_importing',
    'manual',
    'manual_snap',
  ] as const);
  if (kind === 'zero_datum') {
    return {
      placement: {
        type: 'zero_datum',
        coordinates: {
          latitude: roundedFloat(ctx, 20.2, 20.5, 6),
          longitude: roundedFloat(ctx, -87.5, -87.2, 6),
          depth_reference: roundedFloat(ctx, 0, 5, 2),
        },
        station_index: station(),
      },
      label: 'zeroDatum',
    };
  }
  if (kind === 'from_existing') {
    const existing = target();
    return {
      placement: { type: 'from_existing', import_station: station(), existing_station: existing },
      label: `fromExisting(${existing.section_id}/${existing.station_index})`,
    };
  }
  if (kind === 'from_importing') {
    // A sibling in the same batch, including this config itself - a self
    // reference is a cycle the command has to refuse rather than hang on.
    return {
      placement: {
        type: 'from_importing',
        import_station: station(),
        target_section_index: ctx.randInt(0, Math.max(0, sectionIndex)),
        target_station_index: ctx.randInt(0, 4),
      },
      label: 'fromImporting',
    };
  }
  if (kind === 'manual') {
    return {
      placement: {
        type: 'manual',
        align_station_index: station(),
        offset: chance(ctx, 0.3) ? null : drawCoordinates(ctx),
      },
      label: 'manual',
    };
  }
  if (kind === 'manual_snap') {
    const snapped = target();
    return {
      placement: { type: 'manual_snap', align_station_index: station(), snapped_to_station: snapped },
      label: `manualSnap(${snapped.section_id}/${snapped.station_index})`,
    };
  }
  return { placement: { type: 'origin' }, label: 'origin' };
}

/**
 * One `ImportSectionConfig`.
 *
 * `shotBudget` is what is left of `MAX_IMPORT_SHOTS` for the whole batch, so a
 * many-section draw stays affordable by giving every section fewer shots rather
 * than by refusing to draw the section at all - the section COUNT is the axis
 * that exercises placement, and it is the one worth keeping.
 */
function drawSectionConfig(
  ctx: ScenarioContext,
  state: TargetingDigest,
  sectionIndex: number,
  shotBudget: number,
  duplicateName: string | null,
): { config: Record<string, unknown>; label: string; shots: number } {
  const shotCount = Math.max(0, Math.min(shotBudget, ctx.randInt(0, 4)));
  const shots: Record<string, unknown>[] = [];
  for (let i = 0; i < shotCount; i++) shots.push(randomShotData(ctx));
  const stationCount = shotCount + 1;
  const { placement, label: placementLabel } = drawPlacement(ctx, state, sectionIndex, stationCount);
  const comments: [number, string][] = [];
  if (chance(ctx, 0.4)) {
    const count = ctx.randInt(1, 2);
    for (let i = 0; i < count; i++) {
      // Deliberately allowed past the end: a comment on a station that does not
      // exist must be dropped or refused, never written into a neighbour.
      const at = chance(ctx, 0.25) ? ctx.randInt(stationCount, stationCount + 4) : ctx.randInt(0, Math.max(0, stationCount - 1));
      comments.push([at, biasedText(ctx, `imported-${ctx.randInt(0, 999)}`)]);
    }
  }
  const name = duplicateName ?? (chance(ctx, 0.1) ? null : biasedText(ctx, `v3-import-${ctx.randInt(1000, 9999)}`));
  return {
    config: {
      // Occasionally NOT this config's position: `section_index` is what the
      // receipt and the placement graph key on, so a duplicated or out-of-range
      // one is a shape the command has to survive.
      section_index: chance(ctx, 0.1) ? ctx.randInt(0, MAX_IMPORT_SECTIONS + 2) : sectionIndex,
      name,
      surveyor: chance(ctx, 0.7) ? biasedText(ctx, `v3-surveyor-${ctx.randInt(1, 9)}`) : null,
      date: drawDate(ctx),
      color: ctx.pick(COLORS),
      direction: chance(ctx, 0.1) ? null : ctx.pick(SURVEY_DIRECTIONS),
      quality: chance(ctx, 0.15) ? ctx.randInt(-2, 9) : ctx.randInt(1, 5),
      shots,
      placement,
      station_comments: comments,
      reverse: chance(ctx, 0.3),
    },
    label: `${shotCount}sh/${placementLabel}`,
    shots: shotCount,
  };
}

/** A whole `importSections` batch: 0..MAX_IMPORT_SECTIONS configs under one shot cap. */
function drawBatch(
  ctx: ScenarioContext,
  state: TargetingDigest,
): { configs: Record<string, unknown>[]; label: string } {
  // Zero sections is a real case, not a degenerate one: the command returns an
  // EMPTY receipt and pushes nothing, and it is the only route to that branch.
  const count = chance(ctx, 0.08) ? 0 : ctx.randInt(1, MAX_IMPORT_SECTIONS);
  const duplicate = chance(ctx, 0.2) ? biasedText(ctx, `v3-dup-${ctx.randInt(0, 99)}`) : null;
  const configs: Record<string, unknown>[] = [];
  const labels: string[] = [];
  let budget = MAX_IMPORT_SHOTS;
  for (let i = 0; i < count; i++) {
    const drawn = drawSectionConfig(ctx, state, i, budget, duplicate);
    budget -= drawn.shots;
    configs.push(drawn.config);
    labels.push(drawn.label);
  }
  return { configs, label: `${count}sec[${labels.join('|')}]${duplicate === null ? '' : ',dupName'}` };
}

/**
 * The middle args every `importSections` call shares, in the store action's
 * order: `fileHash`, `sectionHashes`, `virtualShotMode`.
 *
 * `existingShotUpdates` is NOT among them and is deliberately the action's LAST
 * parameter rather than the command's third: inserting it in the command's
 * position would have shifted `virtualShotMode` by one for the v2 generator's
 * `[configs, null, null, mode, null]` call, silently re-pointing every v2 import
 * at a different argument. Appending keeps every existing call site - and every
 * v2 repro line - byte-identical.
 */
function importTail(ctx: ScenarioContext, configs: readonly unknown[]): unknown[] {
  const fileHash = chance(ctx, 0.25) ? fakeHash(ctx) : null;
  const sectionHashes = chance(ctx, 0.2) ? configs.map(() => fakeHash(ctx)) : null;
  return [fileHash, sectionHashes, ctx.pick(VIRTUAL_SHOT_MODES)];
}

/**
 * Poison one numeric field of one shot with a non-finite value.
 *
 * Returns the field's name so the label says which, and so a reader can tell a
 * REQUIRED poisoning (refused) from an OPTIONAL one (accepted, value dropped)
 * without re-deriving it.
 */
function poisonShot(
  ctx: ScenarioContext,
  configs: readonly Record<string, unknown>[],
): string | null {
  const withShots = configs.filter((config) => (config.shots as unknown[]).length > 0);
  if (withShots.length === 0) return null;
  const config = ctx.pick(withShots);
  const shots = config.shots as Record<string, unknown>[];
  const shot = ctx.pick(shots);
  const required = chance(ctx, 0.7);
  const field = required ? ctx.pick(REQUIRED_SHOT_NUMBERS) : ctx.pick(OPTIONAL_SHOT_NUMBERS);
  shot[field] = ctx.pick([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
  return field;
}

/**
 * `existing_shot_updates`: the DMP wizard's overlap interpolation, expressed as
 * the payload the wizard would have built.
 *
 * The wizard picks an `OverlapMode` (`import_data` / `existing_data` /
 * `interpolate` / `keep_both`) and `applyAllOverlapTreatments` turns it into two
 * things: edits to the IMPORT section's shots, and `ExistingShotUpdate`s against
 * shots already in the project. Only the second half crosses the IPC boundary,
 * so the four modes are not four wire shapes - they are four DENSITIES of
 * updates over the same shape, and this draws across that range:
 *
 *   - `keep_both`  -> no updates at all, sections carry everything;
 *   - `import_data`-> the existing shots are overwritten wholesale;
 *   - `interpolate`-> a few fields per shot;
 *   - `existing_data` -> the import side is trimmed, updates are empty.
 *
 * The case worth the most is the one the wizard's `useMemo` GREYS OUT: a range
 * whose section is anchored on both sides. The frontend refuses to offer it; the
 * backend has to refuse it INDEPENDENTLY, and it does (`command_import.rs`
 * collects zero datums, datum-backed merges and aligned closures into
 * `anchor_indices` and skips the whole section when one sits on each side). That
 * parity is only tested if something sends the payload the UI will not, which is
 * what this does.
 */
function drawExistingShotUpdates(
  ctx: ScenarioContext,
  state: TargetingDigest,
): { updates: Record<string, unknown>[]; label: string } {
  const count = ctx.randInt(0, 3);
  const updates: Record<string, unknown>[] = [];
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const target = pickShot(ctx, state);
    if (!target) continue;
    const patch: Record<string, unknown> = {};
    const fields = ctx.randInt(1, 3);
    for (let f = 0; f < fields; f++) {
      const key = ctx.pick(UPDATE_NUMBER_FIELDS);
      patch[key] = roundedFloat(ctx, 0, 40, 2);
    }
    if (chance(ctx, 0.25)) patch.kind = ctx.pick(SHOT_KINDS);
    if (chance(ctx, 0.15)) patch.comment = null;
    // A non-finite here is refused by `execute_import_sections` BEFORE any
    // mutation, by name, with its own message - a different refusal from the
    // serde one a poisoned `ShotData` gets, and worth reaching separately.
    if (chance(ctx, 0.15)) patch[ctx.pick(UPDATE_NUMBER_FIELDS)] = Number.NaN;
    updates.push({
      section_id: target.sectionId,
      // A shot id that resolves to nothing is silently skipped by the backend
      // (`find(|s| s.id == update.shot_id)`), which is a documented shape rather
      // than a refusal - so the model must see the command SUCCEED and the
      // project be unchanged by that entry.
      shot_id: chance(ctx, 0.2) ? target.shotId + 100000 : target.shotId,
      updates: patch,
    });
    parts.push(`${target.sectionId}:${target.shotId}`);
  }
  return { updates, label: parts.length === 0 ? 'noUpdates' : parts.join('+') };
}

/**
 * Draw a generated survey file, valid-biased, corrupted with probability
 * `STALAGMIGHT_FUZZ_IMPORT_MALFORMED_P` (default 0.2 - the same knob and the
 * same default `import-dialog-fuzz` uses, read at call time).
 *
 * A malformed file is a REJECTION case, and rejection is a first-class outcome
 * for this scenario: the command must fail without touching the project or
 * either stack, which is the assertion `applyMutation` already makes.
 */
function drawFile(
  ctx: ScenarioContext,
  formats: readonly SurveyFileFormat[],
): { spec: GeneratedFileSpec; rel: string; label: string } {
  const rng = (): number => ctx.rng();
  const format = ctx.pick(formats);
  const malformed = ctx.rng() < malformedProbability();
  const clean = randomSurveyFileSpec(rng, malformed ? 'malformed' : 'valid', format);
  if (!malformed) {
    return { spec: clean, rel: `${FUZZ_FILES_REL}/${clean.name}`, label: format };
  }
  const corrupted = corruptSpec(rng, clean);
  return {
    spec: corrupted.spec,
    rel: `${FUZZ_FILES_REL}/${corrupted.spec.name}`,
    label: `${format}!${corrupted.corruption}`,
  };
}

/** A path under the run's files directory that no generator ever wrote. */
function missingFileRel(ctx: ScenarioContext): string {
  return `${FUZZ_FILES_REL}/absent-${ctx.randInt(0, 999999)}.dmp`;
}

/**
 * Does this exact payload HAVE to be refused?
 *
 * A pure function of the action name and its recorded args, so a replayed trace
 * re-derives the same expectation the recording asserted - which is why the
 * expectation is not carried on `FuzzAction` (it would not survive the trace)
 * and not attached to a generator name (a shrunk trace has no generators).
 *
 * Returns the reason, or null when the payload is legal or its outcome is not
 * ours to claim. Deliberately CONSERVATIVE: it names only the two shapes that
 * are refused by construction at a layer below the command's own logic, so it
 * can never turn a v1/v2 payload red (neither shape is reachable from those
 * generators, which is asserted in `undoRedoFuzzImportActions.test.ts`).
 */
export function mustBeRejected(action: string, args: readonly unknown[]): string | null {
  if (action !== 'importSections') return null;
  const sections = args[0];
  if (!Array.isArray(sections)) return null;
  for (let i = 0; i < sections.length; i++) {
    const config = sections[i] as Record<string, unknown> | null;
    if (config === null || typeof config !== 'object') continue;
    if (config.date === '') {
      return `sections[${i}].date is "" - Option<NaiveDate> parses it as TOO_SHORT ` +
        '("premature end of input"), so Tauri refuses the whole call (issue #478)';
    }
    const shots = config.shots;
    if (!Array.isArray(shots)) continue;
    for (let s = 0; s < shots.length; s++) {
      const shot = shots[s] as Record<string, unknown> | null;
      if (shot === null || typeof shot !== 'object') continue;
      for (const field of REQUIRED_SHOT_NUMBERS) {
        const value = shot[field];
        if (typeof value === 'number' && Number.isFinite(value)) continue;
        return `sections[${i}].shots[${s}].${field} is ${JSON.stringify(value ?? null)} - ` +
          'a required f64 cannot be null/NaN/Infinity, so serde refuses the call before it runs';
      }
    }
  }
  // Index 5: `existingShotUpdates` is the store action's LAST parameter - see
  // `importTail` for why it is appended rather than placed at the command's
  // third position.
  const updates = args[5];
  if (Array.isArray(updates)) {
    for (let i = 0; i < updates.length; i++) {
      const update = updates[i] as Record<string, unknown> | null;
      if (update === null || typeof update !== 'object') continue;
      const patch = update.updates as Record<string, unknown> | null;
      if (patch === null || typeof patch !== 'object') continue;
      for (const [key, value] of Object.entries(patch)) {
        if (typeof value !== 'number' || Number.isFinite(value)) continue;
        return `existing_shot_updates[${i}].updates.${key} is non-finite - ` +
          '`execute_import_sections` refuses it by name before any mutation';
      }
    }
  }
  return null;
}

/**
 * The v3 group. Weights sum to 40 against the v1+v2 total of 140, so imports are
 * about 22% of a balanced run's draws - a minority, by design.
 */
export const IMPORT_ACTION_GENERATORS: readonly ActionGenerator[] = [
  {
    name: 'importSectionsSynthetic',
    weight: 8,
    since: 'v3',
    build(ctx, state) {
      const { configs, label } = drawBatch(ctx, state);
      return {
        action: 'importSections',
        args: [configs, ...importTail(ctx, configs), null],
        label: `importSections(${label})`,
      };
    },
  },
  {
    name: 'importSectionsNonFinite',
    weight: 3,
    since: 'v3',
    build(ctx, state) {
      const { configs, label } = drawBatch(ctx, state);
      const poisoned = poisonShot(ctx, configs);
      if (poisoned === null) return null;
      return {
        action: 'importSections',
        args: [configs, ...importTail(ctx, configs), null],
        label: `importSections(${label},POISON=${poisoned})`,
      };
    },
  },
  {
    name: 'importSectionsWithOverlap',
    weight: 5,
    since: 'v3',
    build(ctx, state) {
      const { configs, label } = drawBatch(ctx, state);
      const { updates, label: updateLabel } = drawExistingShotUpdates(ctx, state);
      return {
        action: 'importSections',
        args: [configs, ...importTail(ctx, configs), null, updates],
        label: `importSections(${label},overlap=${updateLabel})`,
      };
    },
  },
  {
    name: 'importTmlFile',
    weight: 3,
    since: 'v3',
    build(ctx) {
      const file = drawFile(ctx, TML_FORMATS);
      return {
        action: 'executeTmlImport',
        args: [
          file.rel,
          chance(ctx, 0.25) ? fakeHash(ctx) : null,
          chance(ctx, 0.3),
          chance(ctx, 0.7),
          chance(ctx, 0.3) ? null : ctx.pick(VIRTUAL_SHOT_MODES),
        ],
        label: `executeTmlImport(${file.label})`,
        file: { spec: file.spec, rel: file.rel },
      };
    },
  },
  {
    name: 'importCompassFile',
    weight: 3,
    since: 'v3',
    build(ctx) {
      const file = drawFile(ctx, COMPASS_FORMATS);
      return {
        action: 'executeCompassImport',
        args: [
          file.rel,
          chance(ctx, 0.25) ? fakeHash(ctx) : null,
          chance(ctx, 0.3),
          chance(ctx, 0.7),
          chance(ctx, 0.7),
        ],
        label: `executeCompassImport(${file.label})`,
        file: { spec: file.spec, rel: file.rel },
      };
    },
  },
  {
    name: 'importWallsFile',
    weight: 3,
    since: 'v3',
    build(ctx) {
      const file = drawFile(ctx, WALLS_FORMATS);
      // `null` imports every survey; a list picks indices into the preview,
      // including indices the file does not have.
      const selected = chance(ctx, 0.3)
        ? Array.from({ length: ctx.randInt(1, 3) }, () => ctx.randInt(0, 4))
        : null;
      return {
        action: 'executeWallsImport',
        args: [file.rel, chance(ctx, 0.25) ? fakeHash(ctx) : null, chance(ctx, 0.7), chance(ctx, 0.3), selected],
        label: `executeWallsImport(${file.label}${selected === null ? '' : `,sel=${selected.length}`})`,
        file: { spec: file.spec, rel: file.rel },
      };
    },
  },
  {
    name: 'importGpxFile',
    weight: 3,
    since: 'v3',
    build(ctx, state) {
      const file = drawFile(ctx, ['gpx']);
      const placements: Record<string, unknown>[] = [];
      const count = ctx.randInt(0, 3);
      for (let i = 0; i < count; i++) {
        const { placement } = drawPlacement(ctx, state, i, 1);
        placements.push({
          section_index: i,
          placement,
          name: chance(ctx, 0.3) ? null : biasedText(ctx, `gpx-${ctx.randInt(0, 999)}`),
          color: ctx.pick(COLORS),
        });
      }
      return {
        action: 'executeGpxImport',
        args: [
          file.rel,
          chance(ctx, 0.25) ? fakeHash(ctx) : null,
          chance(ctx, 0.8),
          chance(ctx, 0.6),
          chance(ctx, 0.4),
          placements,
          chance(ctx, 0.2),
        ],
        label: `executeGpxImport(${file.label},place=${count})`,
        file: { spec: file.spec, rel: file.rel },
      };
    },
  },
  {
    name: 'parseDmpFile',
    weight: 2,
    since: 'v3',
    build(ctx) {
      const file = drawFile(ctx, ['dmp']);
      // Parse-only: it must push nothing and change nothing, which is the
      // no-op arm of the model's case analysis.
      return {
        action: 'importDmp',
        args: [file.rel],
        label: `importDmp(${file.label})`,
        file: { spec: file.spec, rel: file.rel },
      };
    },
  },
  {
    name: 'probeFileHash',
    weight: 2,
    since: 'v3',
    build(ctx) {
      // Half the draws point at a file that was never written: `read` fails and
      // the probe REJECTS, which must also leave the project alone.
      if (chance(ctx, 0.5)) {
        return { action: 'calculateFileHash', args: [missingFileRel(ctx)], label: 'calculateFileHash(absent)' };
      }
      const file = drawFile(ctx, ['dmp']);
      return {
        action: 'calculateFileHash',
        args: [file.rel],
        label: `calculateFileHash(${file.label})`,
        file: { spec: file.spec, rel: file.rel },
      };
    },
  },
  {
    name: 'probeDuplicateImport',
    weight: 2,
    since: 'v3',
    build(ctx) {
      const hash = chance(ctx, 0.15) ? '' : fakeHash(ctx);
      return {
        action: 'checkDuplicateImport',
        args: [hash],
        label: `checkDuplicateImport(${hash === '' ? 'empty' : 'hash'})`,
      };
    },
  },
  {
    name: 'probeSectionHashes',
    weight: 2,
    since: 'v3',
    build(ctx) {
      const count = ctx.randInt(0, 4);
      const hashes = Array.from({ length: count }, () => fakeHash(ctx));
      return { action: 'checkSectionHashes', args: [hashes], label: `checkSectionHashes(n=${count})` };
    },
  },
  {
    name: 'probeSuggestPlacement',
    weight: 2,
    since: 'v3',
    build(ctx) {
      const count = ctx.randInt(1, 4);
      const shots = Array.from({ length: count }, () => randomShotData(ctx));
      return { action: 'suggestImportPlacement', args: [shots], label: `suggestImportPlacement(n=${count})` };
    },
  },
  {
    name: 'probeSaveAfterImport',
    weight: 2,
    since: 'v3',
    build(_ctx, state) {
      // Only meaningful with a project open, which is always true here - the
      // digest is read from one. `importContext` is null for this scenario (it
      // never opens the wizard), so this takes the EXISTING-project branch:
      // mark dirty, mirror the SpeleoDB flag, return true. It must NOT save, and
      // a save with no undo entry is exactly what the model would catch.
      //
      // The guard reads the digest directly rather than through `pickSection`,
      // which would consume a draw for a decision that has no randomness in it.
      if (state.s.length === 0) return null;
      return { action: 'saveAfterImport', args: [], label: 'saveAfterImport()' };
    },
  },
];

/** Names in this group, for the allowlist test and for documentation. */
export function importGeneratorNames(): string[] {
  return IMPORT_ACTION_GENERATORS.map((generator) => generator.name);
}
