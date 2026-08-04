/**
 * NODE-SIDE half of the undo/redo fuzzer's oracle: the diff reporter and the
 * known-asymmetry classifier.
 *
 * The canonical snapshot itself is taken IN THE WEBVIEW - see
 * `fuzzOracleCore.ts`, which owns the serializer and documents what it
 * normalizes. Only the rare, slow paths live here: when two canonical strings
 * disagree, Node fetches both and works out whether the difference is real,
 * floating-point dust, or one of the open bugs listed below.
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
 * An undo/redo asymmetry that is a KNOWN OPEN APP BUG rather than expected
 * behaviour. These are NOT normalized away - a snapshot mismatch on one of
 * these paths still fails the fuzzer. The classification exists so the failure
 * message can name the bug instead of reading as a fresh mystery, and so a
 * developer working on something else can opt into tolerating it (see the
 * scenario's `STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS` escape hatch).
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

/** True for `<absent>`, or for a coordinate pair whose every member is ~0. */
function isAbsentOrZeroPair(text: string): boolean {
  if (text === ABSENT) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every((value) => typeof value === 'number' && Math.abs(value) <= DEFAULT_TOLERANCE.absolute)
  );
}

export const KNOWN_UNDO_ASYMMETRIES: readonly KnownAsymmetry[] = [
  {
    id: 'create-section-redo-remints-shot-uuids',
    pathPattern: /^project\.sections\[\d+\]\.shots\[\d+\]\.uuid$/,
    description:
      'Redo of CreateSection re-mints every shot uuid. `UndoData::CreatedSectionSnapshot` ' +
      'stores a `SectionData` (which has no uuid field), so redo goes ' +
      'restore_section -> Section::new_with_id -> Shot::new -> Uuid::new_v4(). The sibling ' +
      'CreateShot path was explicitly fixed for exactly this reason ' +
      '(`UndoData::CreatedShotSnapshot { uuid }`, core/state/undo.rs) because a fresh uuid ' +
      'dangles every `StationKey::AfterShot` anchor and the Ariane export identity.',
  },
  {
    id: 'undo-leaks-orphan-zero-section-offset',
    pathPattern: /^project\.section_offsets\.\d+$/,
    accepts: (diff) => isAbsentOrZeroPair(diff.expected) && isAbsentOrZeroPair(diff.actual),
    description:
      'Undoing a shot insert leaves behind a section_offsets entry the section did not have ' +
      'before. The offset cascade INSERTS a key while solving (adjust_section_offset, ' +
      'models/project/connectivity.rs) and nothing removes it again, so an all-zero entry ' +
      'survives the undo. Geometrically inert (the value is 0, or 2.2e-16), but it means undo ' +
      'is not an exact inverse and the leaked key is serialized into the .stalx. NOTE the ' +
      'value narrowing: an offset key appearing with REAL geometry in it is a different, ' +
      'unclassified failure and still fails the fuzzer.',
  },
];

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
  /** Diffs explained by a known open app bug. */
  known: { diff: SnapshotDiff; asymmetry: KnownAsymmetry }[];
  /** Diffs nothing known accounts for. */
  unknown: SnapshotDiff[];
  /** Distinct known asymmetries hit. */
  asymmetries: KnownAsymmetry[];
}

export function classifyDiffs(
  diffs: readonly SnapshotDiff[],
  known: readonly KnownAsymmetry[] = KNOWN_UNDO_ASYMMETRIES,
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
 * This is a classification tool, never a comparison one: the snapshots are still
 * unequal and the fuzzer still fails. It exists so "undo reordered the closure
 * list" can be reported as exactly that, instead of as 30 unrelated-looking
 * value diffs at shifted indices.
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
