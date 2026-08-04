import { describe, expect, it } from 'vitest';

import {
  NON_ROLLBACK_PATHS,
  ORACLE_GLOBAL,
  SIGNIFICANT_DIGITS,
  buildTargetingDigest,
  canonicalProjectSnapshot,
  oracleInjectionSource,
  type TargetingDigest,
} from './fuzzOracleCore';

/** Shape-accurate slice of a `get_project_state` payload. */
function projectState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: {
      name: 'p',
      created_at: '2026-01-01T00:00:00Z',
      modified_at: '2026-01-02T00:00:00Z',
      file_path: '/tmp/a.stalx',
      next_section_id: 9,
      next_closure_id: 3,
      section_offsets: { 10: [3.5, 4.5], 2: [1.5, 2.5] },
      sections: [
        {
          id: 4,
          name: 's4',
          next_shot_id: 400002,
          reverse_parity: true,
          gauge_shot_uuid: 'g-1',
          shots: [
            { id: 400000, uuid: 'u-a', length: 5.125 },
            { id: 400001, uuid: 'u-b', length: 6.25 },
          ],
        },
        { id: 1, name: 's1', next_shot_id: 100001, shots: [{ id: 100000, uuid: 'u-c', length: 1 }] },
      ],
      station_merges: [
        { station_a: { section_id: 4, station_index: 0 }, station_b: { section_id: 1, station_index: 1 }, merged_at: 't' },
      ],
      zero_datums: [{ station_ref: { section_id: 1, station_index: 0 }, gps: { latitude: 20.5 } }],
      loop_closures: [
        { id: 7, station_a: { section_id: 4, station_index: 1 }, path_length: 12.5 },
        { id: 2, station_a: { section_id: 1, station_index: 0 }, path_length: 30 },
      ],
      imported_file_hashes: ['h1'],
      ...overrides,
    },
    stations: [
      { station_ref: { section_id: 4, station_index: 0 }, coordinates: { x: 0, y: 0, z: 0 } },
      { station_ref: { section_id: 4, station_index: 1 }, coordinates: { x: 1.5, y: 0, z: 0 } },
      { station_ref: { section_id: 1, station_index: 0 }, coordinates: { x: 9, y: 9, z: 0 }, comment: 'c' },
    ],
    stats: { section_count: 2, shot_count: 3 },
    frozen_shots: [],
  };
}

/** Evaluate the injected source the way the webview does, with no outer scope. */
function evalInjected(): { canonical: (s: unknown) => string; digest: (s: unknown) => TargetingDigest } {
  const factory = new Function(`${oracleInjectionSource()}\nreturn globalThis.${ORACLE_GLOBAL};`);
  return factory() as { canonical: (s: unknown) => string; digest: (s: unknown) => TargetingDigest };
}

describe('oracle core is a single source of truth', () => {
  it('produces byte-identical canonical output injected and called directly', () => {
    const state = projectState();

    // A stray reference to anything outside the function would throw
    // ReferenceError here, because `new Function` closes over nothing.
    expect(evalInjected().canonical(state)).toBe(canonicalProjectSnapshot(state));
  });

  it('produces an identical digest injected and called directly', () => {
    const state = projectState();

    expect(evalInjected().digest(state)).toEqual(buildTargetingDigest(state));
  });

  it('agrees on a payload with nothing in it', () => {
    const empty = { project: { sections: [] }, stations: [], stats: {}, frozen_shots: [] };

    expect(evalInjected().canonical(empty)).toBe(canonicalProjectSnapshot(empty));
    expect(evalInjected().digest(empty)).toEqual(buildTargetingDigest(empty));
  });

  it('refuses to inject anything that is not a plain function declaration', () => {
    // The guard itself: proves a renamed/wrapped source would be caught rather
    // than silently shipped to the page.
    expect(oracleInjectionSource()).toContain('function canonicalProjectSnapshot(');
    expect(oracleInjectionSource()).toContain('function buildTargetingDigest(');
    expect(oracleInjectionSource()).toContain(`globalThis.${ORACLE_GLOBAL} =`);
  });

  it('installs only the oracle, and nothing that can write app state', () => {
    const source = oracleInjectionSource();

    expect(source).not.toMatch(/__E2E_TEST__|__TAURI__/);
    expect(source).not.toMatch(/\binvoke\b/);
  });
});

describe('canonicalProjectSnapshot', () => {
  it('drops exactly the documented non-rolling-back fields', () => {
    const parsed = JSON.parse(canonicalProjectSnapshot(projectState())) as {
      project: Record<string, unknown> & { sections: Record<string, unknown>[] };
    };

    expect(NON_ROLLBACK_PATHS).toEqual([
      'project.modified_at',
      'project.file_path',
      'project.next_section_id',
      'project.next_closure_id',
      'project.sections.*.next_shot_id',
    ]);
    for (const key of ['modified_at', 'file_path', 'next_section_id', 'next_closure_id']) {
      expect(key in parsed.project).toBe(false);
    }
    expect('next_shot_id' in (parsed.project.sections[0] as object)).toBe(false);
    // ...and keeps everything a real undo bug would show up in.
    expect(parsed.project.created_at).toBe('2026-01-01T00:00:00Z');
    expect(parsed.project.sections[0]?.reverse_parity).toBe(true);
    expect(parsed.project.sections[0]?.gauge_shot_uuid).toBe('g-1');
  });

  it('keeps shot uuids so the CreateSection-redo re-mint is still reported', () => {
    const mutated = projectState();
    const sections = (mutated.project as { sections: { shots: { uuid: string }[] }[] }).sections;
    const shot = sections[0]?.shots[0];
    if (shot) shot.uuid = 'changed';

    expect(canonicalProjectSnapshot(mutated)).not.toBe(canonicalProjectSnapshot(projectState()));
  });

  it('is insensitive to map key order (HashMap-backed section_offsets)', () => {
    const shuffled = projectState({ section_offsets: { 2: [1.5, 2.5], 10: [3.5, 4.5] } });

    expect(canonicalProjectSnapshot(shuffled)).toBe(canonicalProjectSnapshot(projectState()));
  });

  it('sorts nested object keys so insertion order never leaks in', () => {
    const a = canonicalProjectSnapshot({ stats: { b: 1, a: { d: 2, c: 3 } } });
    const b = canonicalProjectSnapshot({ stats: { a: { c: 3, d: 2 }, b: 1 } });

    expect(a).toBe(b);
    expect(a).toBe('{"stats":{"a":{"c":3,"d":2},"b":1}}');
  });

  it('does not confuse a dropped path with a same-named field elsewhere', () => {
    const parsed = JSON.parse(
      canonicalProjectSnapshot({ project: { name: 'p' }, stats: { modified_at: 'keep', file_path: 'keep' } }),
    ) as { stats: Record<string, unknown> };

    expect(parsed.stats.modified_at).toBe('keep');
    expect(parsed.stats.file_path).toBe('keep');
  });

  it('rounds to the documented number of significant digits', () => {
    expect(SIGNIFICANT_DIGITS).toBe(12);
    expect(canonicalProjectSnapshot({ x: 1 + 1e-15 })).toBe('{"x":1}');
    expect(canonicalProjectSnapshot({ x: 0 })).toBe('{"x":0}');
    expect(canonicalProjectSnapshot({ x: 123456789.012345 })).toBe('{"x":123456789.012}');
    // A real geometry regression survives the rounding.
    expect(canonicalProjectSnapshot({ x: 10.001 })).not.toBe(canonicalProjectSnapshot({ x: 10.002 }));
  });

  it('renders u64-style bigints as text rather than throwing', () => {
    expect(canonicalProjectSnapshot({ id: 7n })).toBe('{"id":"7"}');
  });

  it('serializes a null payload rather than returning undefined', () => {
    expect(canonicalProjectSnapshot(null)).toBe('null');
    expect(canonicalProjectSnapshot(undefined)).toBe('null');
  });
});

describe('buildTargetingDigest', () => {
  it('carries exactly the fields the generators read, in payload order', () => {
    expect(buildTargetingDigest(projectState())).toEqual({
      // Section order preserved (4 before 1), shot ids in shot order.
      s: [
        [4, [400000, 400001]],
        [1, [100000]],
      ],
      st: [
        [4, 0],
        [4, 1],
        [1, 0],
      ],
      m: [[4, 0, 1, 1]],
      z: [[1, 0]],
      // Closure order preserved (7 before 2) - the generator sorts it itself.
      c: [7, 2],
    });
  });

  it('survives a payload missing every optional collection', () => {
    expect(buildTargetingDigest({})).toEqual({ s: [], st: [], m: [], z: [], c: [] });
    expect(buildTargetingDigest(null)).toEqual({ s: [], st: [], m: [], z: [], c: [] });
  });

  it('handles a section with no shots', () => {
    const state = { project: { sections: [{ id: 3, shots: [] }] }, stations: [] };

    expect(buildTargetingDigest(state).s).toEqual([[3, []]]);
  });

  it('is far smaller than the payload it summarizes', () => {
    const state = projectState();

    expect(JSON.stringify(buildTargetingDigest(state)).length).toBeLessThan(
      canonicalProjectSnapshot(state).length / 2,
    );
  });
});
