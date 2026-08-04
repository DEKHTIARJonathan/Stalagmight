import { describe, expect, it } from 'vitest';

import {
  NON_ROLLBACK_PATHS,
  ORACLE_GLOBAL,
  SIGNIFICANT_DIGITS,
  buildTargetingDigest,
  canonicalProjectSnapshot,
  checkProjectInvariants,
  idAgnosticSnapshot,
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

describe('checkProjectInvariants', () => {
  /** A minimal SOUND state: 2 sections, 1 and 2 shots, 5 stations. */
  function sound(): Record<string, unknown> {
    return {
      project: {
        next_section_id: 3,
        next_closure_id: 2,
        sections: [
          { id: 1, next_shot_id: 100001, shots: [{ id: 100000, uuid: 'a' }] },
          { id: 2, next_shot_id: 200002, shots: [{ id: 200000, uuid: 'b' }, { id: 200001, uuid: 'c' }] },
        ],
        station_merges: [
          { station_a: { section_id: 1, station_index: 1 }, station_b: { section_id: 2, station_index: 0 } },
        ],
        zero_datums: [{ station_ref: { section_id: 1, station_index: 0 } }],
        loop_closures: [
          {
            id: 1,
            station_a: { section_id: 1, station_index: 0 },
            station_b: { section_id: 2, station_index: 2 },
          },
        ],
      },
      stations: [
        { station_ref: { section_id: 1, station_index: 0 } },
        { station_ref: { section_id: 1, station_index: 1 } },
        { station_ref: { section_id: 2, station_index: 0 } },
        { station_ref: { section_id: 2, station_index: 1 } },
        { station_ref: { section_id: 2, station_index: 2 } },
      ],
      stats: { section_count: 2, shot_count: 3, station_count: 5 },
      frozen_shots: [{ section_id: 2, shot_index: 1 }],
    };
  }

  /** Mutate a copy of the sound state and return the violations it produces. */
  function violationsAfter(mutate: (state: Record<string, unknown>) => void): string[] {
    const state = sound();
    mutate(state);
    return checkProjectInvariants(state);
  }

  it('passes a well-formed state', () => {
    expect(checkProjectInvariants(sound())).toEqual([]);
  });

  it('survives an empty or absent payload rather than throwing', () => {
    expect(checkProjectInvariants({})).toEqual([]);
    expect(checkProjectInvariants(null)).toEqual([]);
  });

  it('fires on a duplicate section id', () => {
    const violations = violationsAfter((state) => {
      const sections = (state.project as { sections: { id: number }[] }).sections;
      if (sections[1]) sections[1].id = 1;
    });

    expect(violations.some((v) => v.includes('duplicate section id 1'))).toBe(true);
  });

  it('fires on a duplicate shot id within a section', () => {
    const violations = violationsAfter((state) => {
      const shots = (state.project as { sections: { shots: { id: number }[] }[] }).sections[1]?.shots;
      if (shots?.[1]) shots[1].id = 200000;
    });

    expect(violations.some((v) => v.includes('two shots with id 200000'))).toBe(true);
  });

  it('fires on a duplicate loop closure id', () => {
    const violations = violationsAfter((state) => {
      const project = state.project as { loop_closures: unknown[]; next_closure_id: number };
      project.next_closure_id = 3;
      project.loop_closures.push({
        id: 1,
        station_a: { section_id: 1, station_index: 0 },
        station_b: { section_id: 2, station_index: 0 },
      });
    });

    expect(violations.some((v) => v.includes('duplicate loop closure id 1'))).toBe(true);
  });

  it('fires when an id allocator no longer dominates the live ids', () => {
    expect(
      violationsAfter((state) => {
        (state.project as { next_section_id: number }).next_section_id = 2;
      }).some((v) => v.includes('section id 2 is at or above next_section_id 2')),
    ).toBe(true);

    expect(
      violationsAfter((state) => {
        const sections = (state.project as { sections: { next_shot_id: number }[] }).sections;
        if (sections[0]) sections[0].next_shot_id = 100000;
      }).some((v) => v.includes('at or above next_shot_id')),
    ).toBe(true);

    expect(
      violationsAfter((state) => {
        (state.project as { next_closure_id: number }).next_closure_id = 1;
      }).some((v) => v.includes('at or above next_closure_id')),
    ).toBe(true);
  });

  it('fires on a wire ref pointing at a missing section', () => {
    const violations = violationsAfter((state) => {
      const merges = (state.project as { station_merges: { station_a: { section_id: number } }[] })
        .station_merges;
      if (merges[0]) merges[0].station_a.section_id = 99;
    });

    expect(violations.some((v) => v.includes('station_merges[0].station_a references missing section 99'))).toBe(
      true,
    );
  });

  it('fires on an out-of-range station index (a section with N shots has N+1 stations)', () => {
    // index === shots.length is the terminal station and IS valid...
    expect(
      violationsAfter((state) => {
        const datums = (state.project as { zero_datums: { station_ref: { station_index: number } }[] })
          .zero_datums;
        if (datums[0]) datums[0].station_ref.station_index = 1;
      }),
    ).toEqual([]);
    // ...one past it is not.
    expect(
      violationsAfter((state) => {
        const datums = (state.project as { zero_datums: { station_ref: { station_index: number } }[] })
          .zero_datums;
        if (datums[0]) datums[0].station_ref.station_index = 2;
      }).some((v) => v.includes('out of range for section 1 (0..1)')),
    ).toBe(true);
  });

  it('fires when the derived station list disagrees with the sections', () => {
    const violations = violationsAfter((state) => {
      (state.stations as unknown[]).pop();
      (state.stats as { station_count: number }).station_count = 4;
    });

    expect(violations.some((v) => v.includes('stations has 4 entries but the sections imply 5'))).toBe(true);
  });

  it('fires on a frozen shot outside its section', () => {
    expect(
      violationsAfter((state) => {
        (state.frozen_shots as { shot_index: number }[])[0]!.shot_index = 2;
      }).some((v) => v.includes('frozen_shots[0] shot index 2 out of range')),
    ).toBe(true);

    expect(
      violationsAfter((state) => {
        (state.frozen_shots as { section_id: number }[])[0]!.section_id = 42;
      }).some((v) => v.includes('frozen_shots[0] references missing section 42')),
    ).toBe(true);
  });

  it('fires when derived stats drift from the model', () => {
    expect(
      violationsAfter((state) => {
        (state.stats as { shot_count: number }).shot_count = 99;
      }).some((v) => v.includes('stats.shot_count 99 != 3 shot(s)')),
    ).toBe(true);
    expect(
      violationsAfter((state) => {
        (state.stats as { section_count: number }).section_count = 7;
      }).some((v) => v.includes('stats.section_count 7 != 2 section(s)')),
    ).toBe(true);
  });

  it('does NOT duplicate what check_project_integrity owns', () => {
    // Per-section duplicate uuid, non-finite geometry and orphan section_offsets
    // are the integrity checker's job (and the integrity-delta oracle's); this
    // suite must stay silent on them or every run would double-report.
    const withIntegrityIssues = sound();
    const project = withIntegrityIssues.project as {
      sections: { shots: { uuid: string; length?: number }[] }[];
      section_offsets: Record<number, [number, number]>;
    };
    const shots = project.sections[1]?.shots;
    if (shots?.[0] && shots[1]) shots[1].uuid = shots[0].uuid;
    if (shots?.[0]) shots[0].length = Number.NaN;
    project.section_offsets = { 99: [1, 2] };

    expect(checkProjectInvariants(withIntegrityIssues)).toEqual([]);
  });

  it('runs identically injected and called directly', () => {
    const corrupt = sound();
    (corrupt.project as { next_section_id: number }).next_section_id = 1;

    const injected = new Function(
      `${oracleInjectionSource()}\nreturn globalThis.${ORACLE_GLOBAL}.invariants;`,
    )() as (s: unknown) => string[];

    expect(injected(corrupt)).toEqual(checkProjectInvariants(corrupt));
    expect(injected(corrupt).length).toBeGreaterThan(0);
  });
});

describe('id-agnostic canonicalization (cross save/reload comparison)', () => {
  /** Two sections whose shot ids are NOT positional (a mid-section delete). */
  const preReload = {
    project: {
      sections: [
        { id: 3, shots: [{ id: 300004, uuid: 'u1' }, { id: 300009, uuid: 'u2' }] },
        { id: 7, shots: [{ id: 700002, uuid: 'u3' }] },
      ],
    },
    stations: [],
  };
  /** The same project after a save/reload renumbered ids to section*STRIDE+seq. */
  const postReload = {
    project: {
      sections: [
        { id: 3, shots: [{ id: 300000, uuid: 'u1' }, { id: 300001, uuid: 'u2' }] },
        { id: 7, shots: [{ id: 700000, uuid: 'u3' }] },
      ],
    },
    stations: [],
  };

  it('reports renumbering as a difference in exact mode', () => {
    expect(canonicalProjectSnapshot(preReload)).not.toBe(canonicalProjectSnapshot(postReload));
  });

  it('absorbs renumbering in id-agnostic mode', () => {
    expect(canonicalProjectSnapshot(preReload, true)).toBe(canonicalProjectSnapshot(postReload, true));
  });

  it('converts an already-canonical string to the same id-agnostic form', () => {
    expect(idAgnosticSnapshot(canonicalProjectSnapshot(preReload))).toBe(
      canonicalProjectSnapshot(postReload, true),
    );
  });

  it('is idempotent and leaves a non-snapshot string alone', () => {
    const once = idAgnosticSnapshot(canonicalProjectSnapshot(preReload));
    expect(idAgnosticSnapshot(once)).toBe(once);
    expect(idAgnosticSnapshot('not json')).toBe('not json');
  });

  it('does NOT hide a real change behind the renumbering', () => {
    // Same positions, but a shot's uuid and geometry changed: still different.
    const tampered = JSON.parse(JSON.stringify(postReload)) as typeof postReload;
    const shot = tampered.project.sections[0]?.shots[1];
    if (shot) shot.uuid = 'CHANGED';

    expect(canonicalProjectSnapshot(preReload, true)).not.toBe(canonicalProjectSnapshot(tampered, true));
  });

  it('does not touch SECTION ids, which are persisted and must match', () => {
    const renamedSection = JSON.parse(JSON.stringify(postReload)) as typeof postReload;
    const section = renamedSection.project.sections[1];
    if (section) section.id = 8;

    expect(canonicalProjectSnapshot(postReload, true)).not.toBe(
      canonicalProjectSnapshot(renamedSection, true),
    );
  });

  it('runs identically injected and called directly', () => {
    const injected = new Function(
      `${oracleInjectionSource()}\nreturn globalThis.${ORACLE_GLOBAL};`,
    )() as { canonical: (s: unknown, a?: boolean) => string; idAgnostic: (s: string) => string };

    expect(injected.canonical(preReload, true)).toBe(canonicalProjectSnapshot(preReload, true));
    expect(injected.idAgnostic(canonicalProjectSnapshot(preReload))).toBe(
      idAgnosticSnapshot(canonicalProjectSnapshot(preReload)),
    );
  });
});
