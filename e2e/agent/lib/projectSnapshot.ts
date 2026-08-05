/**
 * NODE-SIDE half of the undo/redo fuzzer's oracle: the diff reporter and the
 * attribution classifier.
 *
 * The canonical snapshot itself is taken IN THE WEBVIEW - see
 * `fuzzOracleCore.ts`, which owns the serializer and documents what it
 * normalizes. Only the rare, slow paths live here: when two canonical strings
 * disagree, Node fetches both and works out whether the difference is real,
 * floating-point dust, or one of the two DOCUMENTED, INTENDED families a save
 * or a reload is allowed to produce (`SAVE_HEALING_MUTATIONS`,
 * `RELOAD_RESOLVED_GEOMETRY`).
 *
 * ## No known-bug classifiers live here any more
 *
 * This file used to carry `KNOWN_UNDO_ASYMMETRIES` (issue #413 findings 1 and
 * 2), `LOOP_CLOSURE_REORDER` (finding 4), `PRE_SAVE_SNAPSHOT_HEAL_REVERT`
 * (finding 11) and `isShotIdentitySwap` (finding 8's tolerance gate). Every one
 * of those findings is fixed in the Rust tier, so each classifier was DELETED
 * per the delete-when-fixed contract the fix waves follow: a classifier that
 * outlives its bug is a tolerance nobody re-examines. What remains is
 * attribution for behaviour the app is designed to have, and it is narrow by
 * path AND by direction.
 *
 * ## Why there is a tolerance at all
 *
 * Station coordinates and section offsets are RE-DERIVED after an undo/redo
 * (`reconcile_geometry()` -> `compute_station_coordinates`), not copied, so a
 * value whose true result is 0 can land on different floating-point dust
 * depending on the order the survey chain was summed in. Observed in practice:
 * `stations[].coordinates.x` coming back as -3.55e-15 where the recorded
 * snapshot had -7.11e-15 (femtometres, either side of a true zero) after `undo`
 * of a `moveStation`.
 *
 * The canonical string is rounded to 12 significant digits, which usually makes
 * the strings match outright; when they do not, `diffJson` compares numbers
 * against `DEFAULT_TOLERANCE` - 1e-9 ABSOLUTE (a nanometre; this is what catches
 * the near-zero case, which no relative bound can) plus 1e-12 relative. A real
 * geometry regression is millimetres at the very least, so nothing a bug could
 * produce is inside that envelope; a caller that wants bit-exactness passes
 * `tolerance: null`.
 */

/**
 * A named, path-and-direction-narrow rule for attributing a snapshot
 * difference to something the app is DOCUMENTED to do without an undo entry -
 * today only the save-time heals and the reload's offset re-solve.
 *
 * The name is historical: these used to double as known-open-bug classifiers,
 * and none of those are left (see the module header). A rule here never makes a
 * comparison green on its own - the scenarios apply them only to comparisons
 * that CROSS a save/reload epoch, and re-baseline rather than ignore.
 */
export interface KnownAsymmetry {
  id: string;
  /** Matched against a diff path such as `project.sections[3].shots[1].uuid`. */
  pathPattern: RegExp;
  /**
   * Optional extra narrowing on the VALUES. A path pattern alone cannot tell
   * "an all-zero offset entry appeared" from "an offset entry with real
   * geometry appeared", and only the first is the known bug.
   */
  accepts?(diff: SnapshotDiff): boolean;
  description: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deterministic JSON for an already-canonical value (keys are pre-sorted). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export interface SnapshotDiff {
  path: string;
  expected: string;
  actual: string;
}

/** Numeric closeness used by the diff: `|a-b| <= absolute + relative*max(|a|,|b|)`. */
export interface NumericTolerance {
  absolute: number;
  relative: number;
}

/** See the module header: a nanometre absolute, 1e-12 relative. */
export const DEFAULT_TOLERANCE: NumericTolerance = { absolute: 1e-9, relative: 1e-12 };

function numbersEqual(a: number, b: number, tolerance: NumericTolerance | null): boolean {
  if (a === b) return true;
  if (!tolerance) return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tolerance.absolute + tolerance.relative * Math.max(Math.abs(a), Math.abs(b));
}

const ABSENT = '<absent>';

function show(value: unknown, maxChars = 160): string {
  if (value === undefined) return ABSENT;
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}...[${text.length} chars]` : text;
}

function walkDiff(
  expected: unknown,
  actual: unknown,
  path: string,
  out: SnapshotDiff[],
  limit: number,
  tolerance: NumericTolerance | null,
): void {
  if (out.length >= limit) return;
  const label = path || '<root>';

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      out.push({ path: `${label}.length`, expected: String(expected.length), actual: String(actual.length) });
      if (out.length >= limit) return;
    }
    const shared = Math.min(expected.length, actual.length);
    for (let i = 0; i < shared; i++) {
      walkDiff(expected[i], actual[i], `${path}[${i}]`, out, limit, tolerance);
      if (out.length >= limit) return;
    }
    return;
  }

  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      const inExpected = key in expected;
      const inActual = key in actual;
      if (!inExpected || !inActual) {
        out.push({
          path: childPath,
          expected: inExpected ? show(expected[key]) : ABSENT,
          actual: inActual ? show(actual[key]) : ABSENT,
        });
      } else {
        walkDiff(expected[key], actual[key], childPath, out, limit, tolerance);
      }
      if (out.length >= limit) return;
    }
    return;
  }

  if (typeof expected === 'number' && typeof actual === 'number') {
    if (!numbersEqual(expected, actual, tolerance)) {
      out.push({ path: label, expected: show(expected), actual: show(actual) });
    }
    return;
  }

  if (expected !== actual) {
    out.push({ path: label, expected: show(expected), actual: show(actual) });
  }
}

/**
 * First `limit` differences between two normalized snapshots. Numbers within
 * `tolerance` are treated as equal; pass `null` for bit-exact comparison.
 */
export function diffJson(
  expected: unknown,
  actual: unknown,
  limit = 6,
  tolerance: NumericTolerance | null = DEFAULT_TOLERANCE,
): SnapshotDiff[] {
  const out: SnapshotDiff[] = [];
  walkDiff(expected, actual, '', out, limit, tolerance);
  return out;
}

/** Diff two canonical snapshot strings (parses them back first). */
export function diffSnapshots(
  expectedJson: string,
  actualJson: string,
  limit = 6,
  tolerance: NumericTolerance | null = DEFAULT_TOLERANCE,
): SnapshotDiff[] {
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  return diffJson(parse(expectedJson), parse(actualJson), limit, tolerance);
}

export interface DiffClassification {
  /** Diffs explained by one of the rules passed in. */
  known: { diff: SnapshotDiff; asymmetry: KnownAsymmetry }[];
  /** Diffs nothing in that list accounts for. */
  unknown: SnapshotDiff[];
  /** Distinct rules hit. */
  asymmetries: KnownAsymmetry[];
}

/**
 * `known` is REQUIRED. It used to default to `KNOWN_UNDO_ASYMMETRIES`, which is
 * deleted (every finding it named is fixed); making the list explicit is what
 * stops a future caller silently re-acquiring a default tolerance.
 */
export function classifyDiffs(
  diffs: readonly SnapshotDiff[],
  known: readonly KnownAsymmetry[],
): DiffClassification {
  const matched: DiffClassification['known'] = [];
  const unknown: SnapshotDiff[] = [];
  const seen = new Map<string, KnownAsymmetry>();
  for (const diff of diffs) {
    const hit = known.find(
      (candidate) => candidate.pathPattern.test(diff.path) && (candidate.accepts?.(diff) ?? true),
    );
    if (hit) {
      matched.push({ diff, asymmetry: hit });
      seen.set(hit.id, hit);
    } else {
      unknown.push(diff);
    }
  }
  return { known: matched, unknown, asymmetries: [...seen.values()] };
}

<<<<<<< HEAD
/**
 * Undo of `RemoveLoopClosure` restores the closure with `loop_closures.push()`
 * (`src-tauri/src/core/state/undo.rs:244`) while the removal took it out with
 * `Vec::remove(pos)`. Same closure, same id, same metrics - new position, and
 * every closure after it shifted. Detected with `isListPermutationOnly` rather
 * than a path pattern, because the signature is a property of the WHOLE
 * snapshot: identical in every respect once the list is reordered.
 */
export const LOOP_CLOSURE_REORDER: KnownAsymmetry = {
  id: 'undo-remove-loop-closure-appends-instead-of-reinserting',
  // Never used: this one is recognised structurally, not by path.
  pathPattern: /^(?!)/,
  description:
    'Undoing a loop-closure removal puts the closure back at the END of ' +
    'project.loop_closures instead of its original index (undo.rs:244 pushes; the ' +
    'removal used Vec::remove(pos)). The list is a Vec, and its order is persisted to the ' +
    '.stalx, indexed by the frontend, and used to build the adjacency lists that ' +
    'resolve_offsets traverses - so this is a real, if quiet, non-inverse.',
};

/**
 * FINDING 11, narrowly. A `ProjectSnapshotPair` captured BEFORE a save holds the
 * PRE-HEAL project in both halves and neither is refreshed, so undoing or
 * redoing that entry silently reverts the save's undo-less heals
 * (`capture_missing_gauge_anchors`, `core/state/project_io.rs`). Tracked at
 * <https://github.com/Stalagmight/Stalagmight/issues/413> and pinned red by
 * `undo_of_a_pre_save_entry_keeps_the_saves_gauge_anchors`
 * (src-tauri/src/core/state/open_undo_bugs_tests.rs).
 *
 * Used ONLY by `undo-persistence-fuzz`, where the shape fires by construction on
 * every iteration (the run saves with a stack of pre-save entries below it and
 * then walks all of them). It is deliberately NOT added to
 * `KNOWN_UNDO_ASYMMETRIES`: `undo-redo-fuzz` reaches finding 11 by luck rather
 * than by construction, and quietly making it tolerable there would change a
 * documented repro.
 *
 * Value-narrowed to value -> null, i.e. the anchors being LOST. A gauge anchor
 * changing from one value to a DIFFERENT one is not this bug and still fails.
 *
 * NOTE the overlap with `create-section-redo-drops-gauge-anchors`: the two are
 * indistinguishable by path and value, and are told apart by WHICH entry the
 * history move consumed (a `create_section` entry means bug 1). The caller picks
 * the order accordingly.
 */
export const PRE_SAVE_SNAPSHOT_HEAL_REVERT: KnownAsymmetry = {
  id: 'pre-save-snapshot-undo-reverts-save-heals',
  pathPattern: /^project\.sections\[\d+\]\.gauge_(shot|neighbour)_uuid$/,
  accepts: (diff) => diff.expected !== 'null' && diff.expected !== ABSENT && diff.actual === 'null',
  description:
    'Finding 11: a ProjectSnapshotPair recorded BEFORE a save holds the pre-heal project in ' +
    'BOTH halves, so undoing or redoing it reverts the save-time gauge-anchor capture ' +
    '(capture_missing_gauge_anchors, core/state/project_io.rs). The damage is not the lost ' +
    'anchors (the next save re-captures them) but that the project at a given undo DEPTH now ' +
    'depends on the ROUTE taken to reach it. Narrowed to value -> null: an anchor changing to a ' +
    'DIFFERENT value is a separate, unclassified failure.',
};

/**
 * True for bug 8's exact signature: ONE section holds the right NUMBER of shots
 * but exactly one of them is the wrong shot - one uuid that should be there is
 * gone and one that should not be there is present.
 *
 * That is what "after a save/reload an undo deletes the WRONG shot" looks like
 * from the outside: `delete_shot` removed one shot instead of another, so the
 * count is right and a single identity is swapped. It is a classification tool,
 * never a comparison one - the snapshots are still unequal.
 * `undo-persistence-fuzz` uses it to walk PAST a known bug-8 instance in tolerant
 * mode, because bug 8 fires high on the restored stack and would otherwise mask
 * the sibling defects that scenario exists to find.
 *
 * Deliberately as narrow as the bug. More than one section affected, more than
 * one shot swapped, a count change, a one-sided disappearance, or a difference
 * that leaves the uuid sets equal all return false. In particular the sweeping
 * re-mint of bug 1 (`redo of CreateSection re-mints EVERY shot uuid`) swaps a
 * whole section's worth of identities at once and is correctly rejected here -
 * it is classified by path instead, which is why callers must run
 * `classifyDiffs` FIRST and only fall through to this when unknown diffs remain.
 */
export function isShotIdentitySwap(deltas: readonly ShotSetDelta[]): boolean {
  const only = deltas.length === 1 ? deltas[0] : undefined;
  if (only === undefined) return false;
  return (
    only.expectedCount === only.actualCount && only.missing.length === 1 && only.extra.length === 1
  );
}

/**
 * Paths OUTSIDE the swapped section that a wrong-shot delete still moves: the
 * geometry every consumer re-derives from shot data. Deleting the wrong shot
 * changes the survey chain, so station coordinates, section offsets and the
 * aggregate stats legitimately follow it.
 *
 * Counts are deliberately absent, as they are in `stale-id-wrong-shot-derived-
 * stats`: bug 8 leaves the shot COUNT unchanged - one shot swapped for another -
 * so a count moving is a different defect and must not be absorbed here.
 */
const SHOT_SWAP_DERIVED_PATHS: readonly RegExp[] = [
  /^stations\[\d+\]\.coordinates\.[xyz]$/,
  /^project\.section_offsets\.\d+(\[\d+\])?$/,
  /^stats\.(total_length|min_depth|max_depth|penetration_distance)$/,
];

/**
 * The only SECTION-level fields a wrong-shot delete can move. Both are uuid
 * anchors into the section's own shot list (`gauge_shot_uuid` /
 * `gauge_neighbour_uuid`), so deleting a shot can dangle them.
 *
 * Everything else on a section - `name`, `color`, `date`, `surveyor`,
 * `quality`, `direction`, `reverse_parity` - is untouched by a shot delete, and
 * a blanket `sections[N].*` allowance swallowed all of them.
 */
const SHOT_SWAP_SECTION_FIELDS = 'gauge_shot_uuid|gauge_neighbour_uuid';

/** Position of the section with `sectionId` in a snapshot's `project.sections`. */
function sectionIndexById(snapshotJson: string, sectionId: number): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotJson);
  } catch {
    return null;
  }
  const project = isPlainObject(parsed) ? parsed.project : null;
  if (!isPlainObject(project) || !Array.isArray(project.sections)) return null;
  const index = project.sections.findIndex(
    (section) => isPlainObject(section) && Number(section.id) === sectionId,
  );
  return index >= 0 ? index : null;
}

/**
 * Did the shots that SURVIVED the swap keep their relative order?
 *
 * Set difference cannot see a reorder, and order is not cosmetic here: the
 * loader renumbers `Shot::id` to `section_id * FEATURE_ID_STRIDE +
 * sequence_order` (`persistence/sqlite/read.rs`), so a reordered list comes back
 * with different ids and every persisted entry naming one addresses a different
 * shot. A reorder riding along with a genuine swap must not be absorbed by it.
 */
function survivingShotsReordered(delta: ShotSetDelta, expectedJson: string, actualJson: string): boolean {
  const uuidsOf = (json: string): string[] | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return null;
    }
    const project = isPlainObject(parsed) ? parsed.project : null;
    if (!isPlainObject(project) || !Array.isArray(project.sections)) return null;
    const section = project.sections.find(
      (candidate) => isPlainObject(candidate) && Number(candidate.id) === delta.sectionId,
    );
    if (!isPlainObject(section) || !Array.isArray(section.shots)) return null;
    return section.shots.map((shot) =>
      isPlainObject(shot) && typeof shot.uuid === 'string' ? shot.uuid : '<no-uuid>',
    );
  };
  const expected = uuidsOf(expectedJson);
  const actual = uuidsOf(actualJson);
  // Unreadable on either side is not "unchanged" - fail closed.
  if (expected === null || actual === null) return true;
  const missing = new Set(delta.missing);
  const extra = new Set(delta.extra);
  const left = expected.filter((uuid) => !missing.has(uuid));
  const right = actual.filter((uuid) => !extra.has(uuid));
  return left.length !== right.length || left.some((uuid, index) => uuid !== right[index]);
}

/**
 * Is the WHOLE mismatch one wrong-shot swap, and nothing else?
 *
 * `isShotIdentitySwap` answers a question about shot uuids alone. That is not
 * enough to tolerate a mismatch: the diff list can carry damage the swap says
 * nothing about - a lost station comment in another section, a dropped loop
 * closure, a reverted section field - and gating on the uuid predicate alone
 * swallowed all of it, then resynced the model onto the corrupted state so it
 * was never reported at any later depth either.
 *
 * So the swap must also ACCOUNT for every remaining diff, and "account for" is
 * kept as narrow as the defect: the swapped section's SHOTS, its two uuid gauge
 * anchors (which a delete can dangle), and the geometry those shots feed.
 * Nothing else - not the section's own name/colour/date, not another section,
 * not a closure, not a count. This is the same standard `isListPermutationOnly`
 * holds itself to: normalize the known shape away, then require the rest to be
 * silent.
 *
 * `actualJson` is needed for the order check, which set difference cannot make.
 */
export function isBug8ShotSwapOnly(
  diffs: readonly SnapshotDiff[],
  deltas: readonly ShotSetDelta[],
  expectedJson: string,
  actualJson: string,
): boolean {
  if (!isShotIdentitySwap(deltas)) return false;
  const delta = deltas[0];
  if (delta === undefined) return false;
  const index = sectionIndexById(expectedJson, delta.sectionId);
  if (index === null) return false;
  if (survivingShotsReordered(delta, expectedJson, actualJson)) return false;
  const section = `project\\.sections\\[${index}\\]`;
  const inSwappedShots = new RegExp(`^${section}\\.shots(\\.|\\[|$)`);
  const swappedSectionAnchor = new RegExp(`^${section}\\.(${SHOT_SWAP_SECTION_FIELDS})$`);
  return diffs.every(
    (diff) =>
      inSwappedShots.test(diff.path) ||
      swappedSectionAnchor.test(diff.path) ||
      SHOT_SWAP_DERIVED_PATHS.some((pattern) => pattern.test(diff.path)),
  );
}

=======
>>>>>>> b9d6b14b (fix(undo): #413 wave 5 - finding 11 residue, finding 27; harness fully strict)
/** Path segments to a list value inside a snapshot. */
export type ListPath = readonly string[];

/** Where the closure list lives in a `get_project_state` payload. */
export const LOOP_CLOSURES_PATH: ListPath = ['project', 'loop_closures'];

function readPath(root: unknown, segments: ListPath): unknown {
  let cursor = root;
  for (const segment of segments) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function writePath(root: unknown, segments: ListPath, value: unknown): void {
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(cursor)) return;
    cursor = cursor[segment];
  }
  const last = segments[segments.length - 1];
  if (isPlainObject(cursor) && last !== undefined) cursor[last] = value;
}

/** Total, content-derived order - no assumption about which field is the key. */
function sortedByCanonical(items: readonly unknown[]): unknown[] {
  return items
    .map((item) => [canonicalJson(item), item] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, item]) => item);
}

/**
 * True when two snapshots hold the SAME list members at `listPath` in a
 * DIFFERENT order and are otherwise identical.
 *
 * DIAGNOSTIC ONLY, and now purely so. It never made a comparison pass - the
 * snapshots are still unequal and the fuzzer still fails - but it used to be the
 * recognizer behind the `undo-remove-loop-closure-appends-instead-of-reinserting`
 * classifier (issue #413 finding 4), which is deleted along with the bug. What
 * survives is the READING of the failure: "undo reordered the closure list"
 * reported as one sentence instead of 30 unrelated-looking value diffs at
 * shifted indices, should anything ever reintroduce that shape.
 */
export function isListPermutationOnly(
  expectedJson: string,
  actualJson: string,
  listPath: ListPath,
): boolean {
  let expected: unknown;
  let actual: unknown;
  try {
    expected = JSON.parse(expectedJson);
    actual = JSON.parse(actualJson);
  } catch {
    return false;
  }
  const expectedList = readPath(expected, listPath);
  const actualList = readPath(actual, listPath);
  if (!Array.isArray(expectedList) || !Array.isArray(actualList)) return false;
  if (expectedList.length !== actualList.length) return false;
  // Already in the same order: whatever differs, it is not a permutation.
  if (canonicalJson(expectedList) === canonicalJson(actualList)) return false;

  writePath(expected, listPath, sortedByCanonical(expectedList));
  writePath(actual, listPath, sortedByCanonical(actualList));
  return diffJson(expected, actual).length === 0;
}

/** Human-readable diff block for a failure message. */
export function describeDiffs(diffs: readonly SnapshotDiff[]): string {
  if (diffs.length === 0) return '  (no structural difference found - the canonical strings differ only in encoding)';
  return diffs
    .map((diff) => `  at ${diff.path}\n    expected: ${diff.expected}\n    actual:   ${diff.actual}`)
    .join('\n');
}

/**
 * Changes a SAVE is documented to make to live project state, with no undo entry
 * of its own (`AppState::save_project`, src-tauri/src/core/state/project_io.rs).
 *
 * These are healing mutations: the save settles identity and drops dead data
 * before writing. They are real state changes the roundtrip model has to account
 * for, but they are ATTRIBUTABLE - so a save whose diff is entirely explained by
 * this list is absorbed (and recorded), while a save that changes ANYTHING else
 * is a hard failure. That is the oracle: "save mutated the project in an
 * undocumented way".
 *
 * Deliberately narrow, by value as well as by path: a gauge anchor may only go
 * from null to a value (capture_missing_*), a uuid may only be filled in, and an
 * offset entry may only disappear (the orphan retain). A gauge anchor CHANGING
 * from one value to another, or an offset entry appearing, is not on this list.
 */
export const SAVE_HEALING_MUTATIONS: readonly KnownAsymmetry[] = [
  {
    id: 'save-captures-missing-gauge-anchors',
    pathPattern: /^project\.sections\[\d+\]\.gauge_(shot|neighbour)_uuid$/,
    accepts: (diff) => diff.expected === 'null' && diff.actual !== 'null',
    description:
      'save_project calls capture_missing_gauge_anchors(), which records the least-squares ' +
      'gauge pair for any section that lacks one (project_io.rs). Null -> value only; it never ' +
      'moves coordinates.',
  },
  {
    id: 'save-backfills-shot-uuids',
    pathPattern: /^project\.sections\[\d+\]\.shots\[\d+\]\.uuid$/,
    accepts: (diff) => (diff.expected === ABSENT || diff.expected === 'null') && diff.actual !== ABSENT,
    description:
      'save_project calls ensure_shot_uuids(), minting a uuid for any shot still missing one ' +
      '(pre-v6 files). Absent -> value only.',
  },
  {
    id: 'save-drops-orphan-section-offsets',
    pathPattern: /^project\.section_offsets\.\d+$/,
    accepts: (diff) => diff.actual === ABSENT,
    description:
      'save_project retains only section_offsets whose section still exists - the SQLite row ' +
      'carries a FOREIGN KEY to sections(id), so an orphan would abort the whole save. ' +
      'Disappearance only.',
  },
];

/**
 * Derived geometry a RELOAD re-solves from scratch.
 *
 * `Project::redrive_offsets_after_load` (src-tauri/src/models/project/offsets.rs:186-188)
 * ends with an unconditional `resolve_offsets()` under the comment "Zero-trust:
 * never honor a persisted derivable offset - re-solve unconditionally so a
 * sub-tolerance stale offset can't survive the load." So `section_offsets` and
 * the station coordinates derived from them are NOT restored from the file -
 * they are recomputed - and a snapshot recorded in-session before the save can
 * legitimately hold a drifted value the reload then corrects. (In this fuzzer's
 * own runs the drift is usually bug 3's or bug 7's, which is exactly the kind of
 * corruption a reload is designed to heal.)
 *
 * Deliberately scoped to those two derived families and applied ONLY to
 * comparisons that cross a reload. Everything else - section and shot fields,
 * uuids, merges, closures, datums, comments, stats - must still match exactly,
 * so this cannot hide a structural divergence.
 *
 * Narrowed by SHAPE, not by magnitude, and the distinction is deliberate. A
 * re-solve MOVES a number: an offset entry appearing or disappearing, or a
 * coordinate turning into null, is structural and is not this - `isNumericMove`
 * rejects those. What is NOT bounded is how far the number moved, because the
 * heal this family exists to absorb is measured in metres: bug 3 displaces a
 * whole section by a shot's horizontal vector (1.13 m in its repro) and
 * RATCHETS on every cycle, and the reload correcting that is the documented
 * case above. Any sub-metre threshold would fail on the heal; any threshold
 * loose enough to pass it would not catch what a threshold is for. So the
 * magnitude is REPORTED instead - `maxNumericDelta` puts it in the attributed
 * line and in a metric - and a number that starts growing is visible rather
 * than silent.
 */
export const RELOAD_RESOLVED_GEOMETRY: readonly KnownAsymmetry[] = [
  {
    id: 'reload-resolves-section-offsets',
    pathPattern: /^project\.section_offsets\.\d+(\[\d+\])?$/,
    accepts: isNumericMove,
    description:
      'A reload re-solves section_offsets unconditionally rather than trusting the persisted ' +
      'value (offsets.rs redrive_offsets_after_load). A numeric MOVE only: an entry appearing ' +
      'or disappearing is structural and is not this.',
  },
  {
    id: 'reload-resolves-station-coordinates',
    pathPattern: /^stations\[\d+\]\.coordinates\.[xyz]$/,
    accepts: isNumericMove,
    description:
      'Station coordinates are derived from section_offsets, so they move with the re-solve a ' +
      'reload performs. A numeric MOVE only.',
  },
];

/** Every finite number in a rendered diff value (`3.5`, `[1,2]`, `<absent>` -> none). */
function numbersIn(text: string): number[] {
  if (text === ABSENT) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed === 'number') return Number.isFinite(parsed) ? [parsed] : [];
  if (Array.isArray(parsed)) {
    const out: number[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'number' || !Number.isFinite(entry)) return [];
      out.push(entry);
    }
    return out;
  }
  return [];
}

/**
 * Is this diff a number (or a tuple of numbers) MOVING to another one?
 *
 * The re-derived-geometry families are about a value being recomputed. A path
 * in one of them that appears, disappears, or changes type is a structural
 * change wearing a geometry path, and must not be absorbed as a re-solve.
 */
export function isNumericMove(diff: SnapshotDiff): boolean {
  const before = numbersIn(diff.expected);
  const after = numbersIn(diff.actual);
  return before.length > 0 && before.length === after.length;
}

/**
 * The largest absolute change across `diffs`, or null when none is numeric.
 *
 * Reported alongside an absorbed geometry difference so its SIZE is on the
 * record: this family has no magnitude bound (see `RELOAD_RESOLVED_GEOMETRY`),
 * which is only defensible while the number is visible.
 */
export function maxNumericDelta(diffs: readonly SnapshotDiff[]): number | null {
  let worst: number | null = null;
  for (const diff of diffs) {
    const before = numbersIn(diff.expected);
    const after = numbersIn(diff.actual);
    if (before.length === 0 || before.length !== after.length) continue;
    for (const [index, value] of before.entries()) {
      const delta = Math.abs(value - (after[index] ?? 0));
      if (worst === null || delta > worst) worst = delta;
    }
  }
  return worst;
}

/** Per-section shot-identity delta between two canonical snapshots. */
export interface ShotSetDelta {
  sectionId: number;
  /** Shot uuids present in `expected` but missing from `actual`. */
  missing: string[];
  /** Shot uuids present in `actual` but missing from `expected`. */
  extra: string[];
  expectedCount: number;
  actualCount: number;
}

/**
 * Which SHOTS (by uuid, the identity that survives a save/reload) a section
 * gained or lost between two snapshots.
 *
 * A shifted shot list produces dozens of field-level diffs that all look like
 * value changes, and those cannot distinguish "the same shots moved" from "a
 * different shot was removed". This answers that directly, which is the
 * difference between a reordering and data loss.
 *
 * Sections present on only ONE side count as the whole section's shots gained
 * or lost. They are the LARGEST identity change there is, and skipping them -
 * which an earlier version did, by iterating `expected` and `continue`ing when
 * the id was missing from `actual` - reported an EMPTY delta for a run that
 * dropped an entire section, whereupon the caller printed "shot identity by
 * uuid is IDENTICAL on both sides - the shots moved, none was lost".
 */
export function shotSetDelta(expectedJson: string, actualJson: string): ShotSetDelta[] {
  const read = (text: string): Map<number, string[]> => {
    const out = new Map<number, string[]>();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return out;
    }
    const project = isPlainObject(parsed) ? parsed.project : null;
    if (!isPlainObject(project) || !Array.isArray(project.sections)) return out;
    for (const section of project.sections) {
      if (!isPlainObject(section) || !Array.isArray(section.shots)) continue;
      const uuids: string[] = [];
      for (const shot of section.shots) {
        if (isPlainObject(shot)) uuids.push(typeof shot.uuid === 'string' ? shot.uuid : '<no-uuid>');
      }
      out.set(Number(section.id), uuids);
    }
    return out;
  };

  const expected = read(expectedJson);
  const actual = read(actualJson);
  const deltas: ShotSetDelta[] = [];
  const sectionIds = [...new Set([...expected.keys(), ...actual.keys()])].sort((a, b) => a - b);
  for (const sectionId of sectionIds) {
    const expectedUuids = expected.get(sectionId) ?? [];
    const actualUuids = actual.get(sectionId) ?? [];
    const actualSet = new Set(actualUuids);
    const expectedSet = new Set(expectedUuids);
    const missing = expectedUuids.filter((uuid) => !actualSet.has(uuid));
    const extra = actualUuids.filter((uuid) => !expectedSet.has(uuid));
    if (missing.length > 0 || extra.length > 0) {
      deltas.push({
        sectionId,
        missing,
        extra,
        expectedCount: expectedUuids.length,
        actualCount: actualUuids.length,
      });
    }
  }
  return deltas;
}

/** Render a shot-set delta for a failure message. */
export function describeShotSetDelta(deltas: readonly ShotSetDelta[]): string {
  return deltas
    .map(
      (delta) =>
        `  section ${delta.sectionId}: ${delta.expectedCount} shot(s) expected, ${delta.actualCount} present\n` +
        `    shots MISSING (present before, gone now): ${JSON.stringify(delta.missing)}\n` +
        `    shots UNEXPECTED (absent before, present now): ${JSON.stringify(delta.extra)}`,
    )
    .join('\n');
}
