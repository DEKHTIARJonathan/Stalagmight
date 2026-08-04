import { describe, expect, it } from 'vitest';

import {
  KNOWN_UNDO_ASYMMETRIES,
  NON_ROLLBACK_PATHS,
  canonicalJson,
  classifyDiffs,
  describeDiffs,
  diffJson,
  diffSnapshots,
  normalizeProjectState,
  roundSignificant,
  snapshotProjectState,
} from './projectSnapshot';

/** Minimal shape-accurate `get_project_state` payload. */
function projectState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: {
      name: 'p',
      location: null,
      created_at: '2026-01-01T00:00:00Z',
      modified_at: '2026-01-01T00:00:00Z',
      sections: [
        {
          id: 1,
          name: 's1',
          color: '#3388FF',
          next_shot_id: 4,
          reverse_parity: false,
          gauge_shot_uuid: null,
          shots: [{ id: 1, uuid: 'u-1', length: 5, comment: null, kind: 'Normal' }],
        },
      ],
      station_merges: [],
      zero_datums: [],
      loop_closures: [],
      file_path: '/tmp/a.stalx',
      next_section_id: 9,
      section_offsets: { 2: [1, 2], 10: [3, 4] },
      imported_file_hashes: [],
      imported_section_hashes: [],
      next_closure_id: 3,
      validation: { warn_shot_length_min: 0.5 },
      ...overrides,
    },
    stations: [{ station_ref: { section_id: 1, station_index: 0 }, coordinates: { x: 0, y: 0, z: 0 } }],
    stats: { section_count: 1, shot_count: 1 },
    frozen_shots: [],
  };
}

describe('normalizeProjectState', () => {
  it('drops exactly the documented non-rolling-back fields', () => {
    const normalized = normalizeProjectState(projectState()) as {
      project: Record<string, unknown> & { sections: Record<string, unknown>[] };
    };

    expect(NON_ROLLBACK_PATHS).toEqual([
      'project.modified_at',
      'project.file_path',
      'project.next_section_id',
      'project.next_closure_id',
      'project.sections.*.next_shot_id',
    ]);
    expect('modified_at' in normalized.project).toBe(false);
    expect('file_path' in normalized.project).toBe(false);
    expect('next_section_id' in normalized.project).toBe(false);
    expect('next_closure_id' in normalized.project).toBe(false);
    expect('next_shot_id' in (normalized.project.sections[0] as object)).toBe(false);
    // ...and keeps the fields a real undo bug would show up in.
    expect(normalized.project.created_at).toBe('2026-01-01T00:00:00Z');
    expect(normalized.project.sections[0]?.reverse_parity).toBe(false);
    expect(normalized.project.sections[0]?.gauge_shot_uuid).toBeNull();
  });

  it('keeps shot uuids so the CreateSection-redo re-mint is still reported', () => {
    const a = snapshotProjectState(projectState());
    const mutated = projectState();
    const project = mutated.project as { sections: { shots: { uuid: string }[] }[] };
    const shot = project.sections[0]?.shots[0];
    if (shot) shot.uuid = 'u-2';

    expect(snapshotProjectState(mutated)).not.toBe(a);
  });

  it('is insensitive to map key order (HashMap-backed section_offsets)', () => {
    const ordered = projectState();
    const shuffled = projectState({ section_offsets: { 10: [3, 4], 2: [1, 2] } });

    expect(snapshotProjectState(shuffled)).toBe(snapshotProjectState(ordered));
  });

  it('sorts nested object keys so insertion order never leaks into the snapshot', () => {
    expect(canonicalJson(normalizeProjectState({ b: 1, a: { d: 2, c: 3 } }, { dropPaths: [] }))).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it('does not confuse a dropped path with a same-named field elsewhere', () => {
    const normalized = normalizeProjectState(
      { project: { name: 'p' }, stats: { modified_at: 'keep-me', file_path: 'keep-me-too' } },
    ) as { stats: Record<string, unknown> };

    expect(normalized.stats.modified_at).toBe('keep-me');
    expect(normalized.stats.file_path).toBe('keep-me-too');
  });

  it('rounds floats to significant digits, and compares exactly when asked', () => {
    expect(roundSignificant(1 + 1e-15, 12)).toBe(1);
    expect(roundSignificant(0, 12)).toBe(0);
    expect(roundSignificant(1.23456789012345e8, 12)).toBe(123456789.012);
    expect(roundSignificant(1 + 1e-15, null)).toBe(1 + 1e-15);
    // A real geometry regression (millimetres, let alone centimetres) survives.
    expect(roundSignificant(10.001, 12)).not.toBe(roundSignificant(10.002, 12));
  });

  it('renders u64-style bigints as text rather than throwing in JSON', () => {
    expect(canonicalJson(normalizeProjectState({ id: 7n }, { dropPaths: [] }))).toBe('{"id":"7"}');
  });
});

describe('diffJson', () => {
  it('names the first differing path with both values', () => {
    const diffs = diffJson({ a: { b: [1, 2, 3] } }, { a: { b: [1, 9, 3] } });

    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.path).toBe('a.b[1]');
    expect(diffs[0]?.expected).toBe('2');
    expect(diffs[0]?.actual).toBe('9');
  });

  it('reports array length changes and missing keys', () => {
    expect(diffJson({ a: [1, 2] }, { a: [1] })[0]).toEqual({
      path: 'a.length',
      expected: '2',
      actual: '1',
    });
    expect(diffJson({ a: 1 }, {})[0]).toEqual({ path: 'a', expected: '1', actual: '<absent>' });
    expect(diffJson({}, { a: 1 })[0]).toEqual({ path: 'a', expected: '<absent>', actual: '1' });
  });

  it('honours the diff limit', () => {
    const expected = { a: 1, b: 2, c: 3, d: 4 };
    const actual = { a: 9, b: 9, c: 9, d: 9 };

    expect(diffJson(expected, actual, 2)).toHaveLength(2);
  });

  it('returns nothing for equal structures', () => {
    expect(diffJson({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toEqual([]);
  });

  it('diffs canonical snapshot strings', () => {
    const diffs = diffSnapshots('{"a":1}', '{"a":2}');

    expect(diffs[0]?.path).toBe('a');
    expect(describeDiffs(diffs)).toContain('at a');
  });
});

describe('classifyDiffs', () => {
  it('recognises the CreateSection-redo shot-uuid re-mint', () => {
    const classified = classifyDiffs([
      { path: 'project.sections[2].shots[0].uuid', expected: '"u-1"', actual: '"u-2"' },
    ]);

    expect(classified.unknown).toHaveLength(0);
    expect(classified.asymmetries.map((a) => a.id)).toEqual(['create-section-redo-remints-shot-uuids']);
  });

  it('does not swallow a neighbouring field on a known-asymmetry path', () => {
    const classified = classifyDiffs([
      { path: 'project.sections[2].shots[0].length', expected: '5', actual: '6' },
    ]);

    expect(classified.known).toHaveLength(0);
    expect(classified.unknown).toHaveLength(1);
  });

  it('exposes each known asymmetry with an id and an explanation', () => {
    for (const asymmetry of KNOWN_UNDO_ASYMMETRIES) {
      expect(asymmetry.id).toMatch(/^[a-z0-9-]+$/);
      expect(asymmetry.description.length).toBeGreaterThan(40);
    }
  });
});
