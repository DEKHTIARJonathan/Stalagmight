/**
 * The undo/redo fuzzer's oracle CORE: the two functions that run in BOTH worlds.
 *
 * Shipping a whole `get_project_state` to Node on every step is the fuzzer's
 * dominant cost (~60 KB on the fractal fixture, ~277 KB on naharon, twice per
 * iteration). So the snapshot is taken and compared INSIDE the webview, and only
 * a verdict plus a small targeting digest crosses the WebDriver bridge.
 *
 * That means the same code has to run in Node (unit tests, and the Node-side
 * diff path) and in the page. It is not duplicated: the functions below are
 * SELF-CONTAINED - no imports, no module-scope references, every helper nested -
 * and `oracleInjectionSource()` serializes them with `Function.prototype
 * .toString()` for injection. tsx/esbuild strips the type annotations and
 * otherwise leaves a plain function declaration, so what the page evaluates is
 * literally the code Node runs. `fuzzOracleCore.test.ts` proves that by feeding
 * the same state to the direct call and to the injected-and-evaled copy and
 * asserting byte-identical output; a stray outer reference would surface there
 * as a ReferenceError, because `new Function` closes over nothing.
 *
 * Do NOT let these two grow a dependency, and do NOT hand-copy them anywhere.
 *
 * ## What the snapshot normalizes, and why so little
 *
 * The fuzzer's claim is "undo/redo roundtrips the project EXACTLY", so the
 * comparison covers the full IPC payload - `project` + `stations` + `stats` +
 * `frozen_shots`. `project` alone is not enough: `ProjectIpc` omits
 * `station_offsets` / `station_comments`, which are only observable through
 * `stations[].coordinates` and `stations[].comment`.
 *
 * Every field dropped is a place a real bug could hide, so the list is short and
 * each entry is a thing that CANNOT match by construction:
 *
 *   - `project.modified_at`  - every undo/redo path calls `Project::touch()`
 *     (`src-tauri/src/core/state/undo.rs`).
 *   - `project.file_path`    - `restore_snapshot_into` carries the LIVE path
 *     across a snapshot restore (`core/state/app_state.rs`).
 *   - `project.next_section_id`, `project.next_closure_id`,
 *     `project.sections.*.next_shot_id` - monotonic id counters, and an
 *     ASYMMETRY rather than a bug: a snapshot-pair undo restores them verbatim
 *     while a targeted undo (`restore_section`, `restore_shot`) only ever raises
 *     them, so comparing them would fire on every mixed history.
 *
 * Everything else is compared: shot uuids, `reverse_parity`, the gauge anchors,
 * `StationMerge.merged_at`, every `LoopClosure` metric, both imported-hash
 * vectors, and all geometry.
 *
 * Two other classes of noise are handled without dropping anything. Object keys
 * are sorted recursively, which canonicalizes `Project::section_offsets` (a
 * `HashMap`, so its JSON key order is not stable across a snapshot restore)
 * without hiding a value. And numbers are rounded to 12 significant digits,
 * because geometry is RE-DERIVED after every undo/redo rather than copied. The
 * rounding is only the fast path: when two canonical strings still disagree,
 * Node re-compares with an absolute tolerance too (see `projectSnapshot.ts`),
 * which is what catches values either side of a true zero.
 */

/** Documentation mirror of the list inlined in `canonicalProjectSnapshot`. */
export const NON_ROLLBACK_PATHS: readonly string[] = [
  'project.modified_at',
  'project.file_path',
  'project.next_section_id',
  'project.next_closure_id',
  'project.sections.*.next_shot_id',
];

/** Documentation mirror of the constant inlined in `canonicalProjectSnapshot`. */
export const SIGNIFICANT_DIGITS = 12;

/**
 * SELF-CONTAINED. Canonical, comparison-ready JSON for a `get_project_state`
 * payload: non-rolling-back fields dropped, every object's keys sorted, every
 * finite number rounded to 12 significant digits. Two states that should be
 * equal produce byte-identical strings.
 *
 * Keep this dependency-free - it is injected into the webview verbatim.
 */
export function canonicalProjectSnapshot(state: unknown): string {
  // Inlined rather than imported: see the module header. `NON_ROLLBACK_PATHS`
  // and `SIGNIFICANT_DIGITS` mirror these, and a unit test pins them together.
  const dropped: Record<string, true> = {
    'project.modified_at': true,
    'project.file_path': true,
    'project.next_section_id': true,
    'project.next_closure_id': true,
    'project.sections.*.next_shot_id': true,
  };
  const digits = 12;

  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const round = (value: number): number => {
    if (!Number.isFinite(value) || value === 0) return value;
    return Number(value.toPrecision(digits));
  };

  const walk = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) {
      const childPath = path ? `${path}.*` : '*';
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) out.push(walk(value[i], childPath));
      return out;
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      const keys = Object.keys(value).sort();
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i] as string;
        const childPath = path ? `${path}.${key}` : key;
        if (dropped[childPath] === true) continue;
        out[key] = walk(value[key], childPath);
      }
      return out;
    }
    if (typeof value === 'number') return round(value);
    // u64 ids can arrive as BigInt through some bridges; compare them as text.
    if (typeof value === 'bigint') return value.toString();
    return value;
  };

  const normalized = walk(state, '');
  return JSON.stringify(normalized === undefined ? null : normalized);
}

/**
 * The compact view of live state the action generators target.
 *
 * Every field here is one the generators in `undoRedoFuzzActions.ts` actually
 * read, and each list is in the SAME ORDER as the payload it came from. Order
 * matters even though every generator re-sorts what it picks from: a sort is
 * only a total order while its keys are unique, and preserving payload order
 * keeps the tie-breaking (and therefore the rng draw sequence, and therefore
 * every documented repro seed) identical to when the generators read the raw
 * project state.
 *
 * Tuples rather than objects because this crosses the bridge on every step:
 * naharon's full payload is ~277 KB, its digest ~15 KB.
 */
export interface TargetingDigest {
  /** `[sectionId, [shotId, ...]]`, in `project.sections` order. */
  s: [number, number[]][];
  /** `[section_id, station_index]`, in `stations` order. */
  st: [number, number][];
  /** `[a.section_id, a.station_index, b.section_id, b.station_index]`, in `project.station_merges` order. */
  m: [number, number, number, number][];
  /** `[section_id, station_index]`, in `project.zero_datums` order. */
  z: [number, number][];
  /** Closure ids, in `project.loop_closures` order. */
  c: number[];
}

/**
 * SELF-CONTAINED. Reduce a `get_project_state` payload to the targeting digest.
 *
 * Keep this dependency-free - it is injected into the webview verbatim.
 */
export function buildTargetingDigest(state: unknown): TargetingDigest {
  const root = (state ?? {}) as Record<string, unknown>;
  const project = (root.project ?? {}) as Record<string, unknown>;
  const sections = Array.isArray(project.sections) ? project.sections : [];
  const stations = Array.isArray(root.stations) ? root.stations : [];
  const merges = Array.isArray(project.station_merges) ? project.station_merges : [];
  const datums = Array.isArray(project.zero_datums) ? project.zero_datums : [];
  const closures = Array.isArray(project.loop_closures) ? project.loop_closures : [];

  const refPair = (value: unknown): [number, number] => {
    const ref = (value ?? {}) as Record<string, unknown>;
    return [Number(ref.section_id), Number(ref.station_index)];
  };

  const s: [number, number[]][] = [];
  for (let i = 0; i < sections.length; i++) {
    const section = (sections[i] ?? {}) as Record<string, unknown>;
    const shots = Array.isArray(section.shots) ? section.shots : [];
    const shotIds: number[] = [];
    for (let j = 0; j < shots.length; j++) {
      shotIds.push(Number((shots[j] as Record<string, unknown>).id));
    }
    s.push([Number(section.id), shotIds]);
  }

  const st: [number, number][] = [];
  for (let i = 0; i < stations.length; i++) {
    st.push(refPair((stations[i] as Record<string, unknown>).station_ref));
  }

  const m: [number, number, number, number][] = [];
  for (let i = 0; i < merges.length; i++) {
    const merge = (merges[i] ?? {}) as Record<string, unknown>;
    const a = refPair(merge.station_a);
    const b = refPair(merge.station_b);
    m.push([a[0], a[1], b[0], b[1]]);
  }

  const z: [number, number][] = [];
  for (let i = 0; i < datums.length; i++) {
    z.push(refPair((datums[i] as Record<string, unknown>).station_ref));
  }

  const c: number[] = [];
  for (let i = 0; i < closures.length; i++) {
    c.push(Number((closures[i] as Record<string, unknown>).id));
  }

  return { s, st, m, z, c };
}

/** Global the injected oracle installs. `globalThis` is `window` in the webview. */
export const ORACLE_GLOBAL = '__FUZZ_ORACLE__';

/**
 * JS source that installs the oracle at `globalThis.__FUZZ_ORACLE__`:
 * the two functions above, verbatim, plus the per-run model state (the
 * canonical snapshot for every undo depth, and the last mismatching pair so
 * Node can fetch it only when it needs it). Nothing else, and nothing that
 * writes to app state.
 *
 * Re-running it resets the model, which is what a scenario does at start.
 */
export function oracleInjectionSource(): string {
  const parts = [
    { name: 'canonicalProjectSnapshot', source: canonicalProjectSnapshot.toString() },
    { name: 'buildTargetingDigest', source: buildTargetingDigest.toString() },
  ];
  for (const part of parts) {
    // A toolchain that renames or wraps these (a minifier, a coverage
    // instrumenter) would otherwise inject something subtly different from what
    // Node runs, which is the one thing this design must never do.
    if (!part.source.startsWith(`function ${part.name}(`)) {
      throw new Error(
        `oracle source for ${part.name} is not a plain function declaration; ` +
          `refusing to inject: ${part.source.slice(0, 80)}`,
      );
    }
  }
  return [
    '(function () {',
    ...parts.map((part) => part.source),
    `globalThis.${ORACLE_GLOBAL} = {`,
    '  canonical: canonicalProjectSnapshot,',
    '  digest: buildTargetingDigest,',
    '  snapshots: [],',
    '  lastExpected: null,',
    '  lastActual: null,',
    '  mismatchIndex: -1,',
    '};',
    '})();',
  ].join('\n');
}
