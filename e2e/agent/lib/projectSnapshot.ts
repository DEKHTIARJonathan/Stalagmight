/**
 * Normalized `get_project_state` snapshots + a diff reporter, for the undo/redo
 * fuzzer oracle (`e2e/agent/scenarios/undoRedoFuzz.ts`).
 *
 * The fuzzer's whole claim is "undo/redo roundtrips the project EXACTLY", so
 * the oracle compares the full IPC payload (`project` + `stations` + `stats` +
 * `frozen_shots`) rather than a cheap signature. `project` alone is not enough:
 * `ProjectIpc` deliberately omits `station_offsets` / `station_comments`, and
 * those only become observable through `stations[].coordinates` and
 * `stations[].comment`.
 *
 * Normalization is deliberately minimal - every field dropped here is a place a
 * real undo bug could hide, so the list is short, justified, and centralized:
 *
 *   - `project.modified_at`  - every undo/redo path calls `Project::touch()`
 *     (`src-tauri/src/core/state/undo.rs`), so it can never match by design.
 *   - `project.file_path`    - `restore_snapshot_into` carries the LIVE path
 *     across a snapshot restore (`core/state/app_state.rs`), and
 *     `serialize_project_snapshot` blanks it on the way in.
 *   - `project.next_section_id`, `project.next_closure_id`,
 *     `project.sections.*.next_shot_id` - monotonic id counters. They are an
 *     ASYMMETRY, not a bug: a snapshot-pair undo restores them verbatim, while
 *     a targeted undo (`restore_section`, `restore_shot`) only ever raises
 *     them. Comparing them would report the asymmetry on every mixed history.
 *
 * Everything else is compared: shot uuids, `reverse_parity`, the gauge anchors,
 * `StationMerge.merged_at`, every `LoopClosure` metric, both imported-hash
 * vectors, and all geometry.
 *
 * Two other classes of noise are handled structurally instead of by dropping:
 *
 *   - MAP ORDER. `Project::section_offsets` is a `HashMap`, so its JSON key
 *     order is not stable across a snapshot restore (a deserialized map gets a
 *     fresh `RandomState`). `normalizeProjectState` sorts every object's keys,
 *     which canonicalizes that (and anything like it) without hiding a value.
 *   - FLOAT NOISE. Station coordinates and section offsets are RE-DERIVED after
 *     an undo/redo (`reconcile_geometry()` -> `compute_station_coordinates`),
 *     not copied, so a value whose true result is 0 can land on different
 *     floating-point dust depending on the order the survey chain was summed in.
 *     Observed in practice: `stations[].coordinates.x` coming back as
 *     -3.55e-15 where the recorded snapshot had -7.11e-15 (femtometres, either
 *     side of a true zero) after `undo` of a `moveStation`.
 *
 *     Two layers handle that. Values are rounded to
 *     `DEFAULT_SIGNIFICANT_DIGITS` (12 significant digits) so the canonical
 *     strings usually match outright, and when they do not, `diffJson` compares
 *     numbers against `DEFAULT_TOLERANCE` - 1e-9 ABSOLUTE (a nanometre; this is
 *     what catches the near-zero case, which no relative bound can) plus 1e-12
 *     relative. A real geometry regression is millimetres at the very least, so
 *     nothing a bug could produce is inside that envelope; a caller that wants
 *     bit-exactness passes `tolerance: null`.
 */

/** Significant digits every finite number is rounded to before comparison. */
export const DEFAULT_SIGNIFICANT_DIGITS = 12;

/**
 * Paths removed before comparison, with `*` standing for any array index.
 * See the module header for why each one is here; adding to this list weakens
 * the oracle, so anything new needs the same kind of justification.
 */
export const NON_ROLLBACK_PATHS: readonly string[] = [
  'project.modified_at',
  'project.file_path',
  'project.next_section_id',
  'project.next_closure_id',
  'project.sections.*.next_shot_id',
];

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
  description: string;
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
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Round to `digits` significant digits; `null` digits means "compare exactly". */
export function roundSignificant(value: number, digits: number | null): number {
  if (digits === null || !Number.isFinite(value) || value === 0) return value;
  if (digits < 1 || digits > 100) return value;
  return Number(value.toPrecision(digits));
}

export interface NormalizeOptions {
  /** Significant digits for float rounding; `null` compares exactly. */
  significantDigits?: number | null;
  /** Path patterns to drop (`*` = any array index). Defaults to `NON_ROLLBACK_PATHS`. */
  dropPaths?: readonly string[];
}

function normalizeValue(
  value: unknown,
  path: string,
  drops: ReadonlySet<string>,
  digits: number | null,
): unknown {
  if (Array.isArray(value)) {
    const childPath = path ? `${path}.*` : '*';
    return value.map((item) => normalizeValue(item, childPath, drops, digits));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    // Sorted so a HashMap-backed map (section_offsets) canonicalizes.
    for (const key of Object.keys(value).sort()) {
      const childPath = path ? `${path}.${key}` : key;
      if (drops.has(childPath)) continue;
      out[key] = normalizeValue(value[key], childPath, drops, digits);
    }
    return out;
  }
  if (typeof value === 'number') return roundSignificant(value, digits);
  // u64 ids can arrive as BigInt through some bridges; compare them as text.
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * Drop the non-rolling-back fields, sort every object's keys, and round floats.
 * The result is order-canonical, so `canonicalJson` of two equal states is
 * byte-identical.
 */
export function normalizeProjectState(state: unknown, opts: NormalizeOptions = {}): unknown {
  const digits = opts.significantDigits === undefined ? DEFAULT_SIGNIFICANT_DIGITS : opts.significantDigits;
  const drops = new Set(opts.dropPaths ?? NON_ROLLBACK_PATHS);
  return normalizeValue(state, '', drops, digits);
}

/** Deterministic JSON for an already-normalized value (keys are pre-sorted). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Normalize + serialize in one step: the snapshot the fuzzer stores per depth. */
export function snapshotProjectState(state: unknown, opts: NormalizeOptions = {}): string {
  return canonicalJson(normalizeProjectState(state, opts));
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
    const hit = known.find((candidate) => candidate.pathPattern.test(diff.path));
    if (hit) {
      matched.push({ diff, asymmetry: hit });
      seen.set(hit.id, hit);
    } else {
      unknown.push(diff);
    }
  }
  return { known: matched, unknown, asymmetries: [...seen.values()] };
}

/** Human-readable diff block for a failure message. */
export function describeDiffs(diffs: readonly SnapshotDiff[]): string {
  if (diffs.length === 0) return '  (no structural difference found - the canonical strings differ only in encoding)';
  return diffs
    .map((diff) => `  at ${diff.path}\n    expected: ${diff.expected}\n    actual:   ${diff.actual}`)
    .join('\n');
}
