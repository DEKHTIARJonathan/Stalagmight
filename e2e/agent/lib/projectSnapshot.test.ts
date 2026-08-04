import { describe, expect, it } from 'vitest';

import {
  KNOWN_UNDO_ASYMMETRIES,
  LOOP_CLOSURES_PATH,
  LOOP_CLOSURE_REORDER,
  canonicalJson,
  classifyDiffs,
  describeDiffs,
  diffJson,
  diffSnapshots,
  isListPermutationOnly,
} from './projectSnapshot';

// The canonical serializer and its normalization rules are tested in
// fuzzOracleCore.test.ts, which owns them. This file covers the Node-only
// half: the tolerant diff, the classifier, and the permutation detector.

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

  it('absorbs re-derived-geometry dust around a true zero', () => {
    // The exact pair the fuzzer hit: undo of a moveStation gave back a
    // coordinate on the other side of zero, 3.6 femtometres away.
    const expected = { stations: [{ coordinates: { x: -3.5527136788e-15 } }] };
    const actual = { stations: [{ coordinates: { x: -7.1054273576e-15 } }] };

    expect(diffJson(expected, actual)).toEqual([]);
    expect(diffJson(expected, actual, 6, null)).toHaveLength(1);
  });

  it('still reports a difference a real geometry regression would produce', () => {
    // A nanometre is the absolute floor; a micrometre is already a failure, and
    // anything a bug could plausibly cause is millimetres or more.
    expect(diffJson({ x: 12.5 }, { x: 12.5 + 1e-6 })).toHaveLength(1);
    expect(diffJson({ x: 12.5 }, { x: 12.501 })).toHaveLength(1);
    expect(diffJson({ x: 0 }, { x: 1e-9 })).toEqual([]);
    expect(diffJson({ x: 0 }, { x: 1e-7 })).toHaveLength(1);
  });

  it('keeps the relative bound tight on large coordinates', () => {
    expect(diffJson({ x: 1e6 }, { x: 1e6 + 1e-9 })).toEqual([]);
    expect(diffJson({ x: 1e6 }, { x: 1e6 + 0.001 })).toHaveLength(1);
  });

  it('does not treat non-finite or non-numeric values as close', () => {
    expect(diffJson({ x: 1 }, { x: '1' })).toHaveLength(1);
    expect(diffJson({ x: 1 }, { x: null })).toHaveLength(1);
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

  it('recognises the orphan zero section_offsets entry an undo leaks', () => {
    const classified = classifyDiffs([
      { path: 'project.section_offsets.32', expected: '<absent>', actual: '[0,0]' },
      { path: 'project.section_offsets.7', expected: '<absent>', actual: '[2.22044604925e-16,0]' },
    ]);

    expect(classified.unknown).toHaveLength(0);
    expect(classified.asymmetries.map((a) => a.id)).toEqual(['undo-leaks-orphan-zero-section-offset']);
  });

  it('does NOT accept an offset entry carrying real geometry as that known bug', () => {
    const classified = classifyDiffs([
      { path: 'project.section_offsets.28', expected: '<absent>', actual: '[-20.6,1.2]' },
      { path: 'project.section_offsets.28[0]', expected: '-19.47', actual: '-20.61' },
    ]);

    expect(classified.known).toHaveLength(0);
    expect(classified.unknown).toHaveLength(2);
  });

  it('exposes the loop-closure reorder with an id and an explanation too', () => {
    expect(LOOP_CLOSURE_REORDER.id).toMatch(/^[a-z0-9-]+$/);
    expect(LOOP_CLOSURE_REORDER.description.length).toBeGreaterThan(40);
    // Recognised structurally, so it must never match by path.
    expect(LOOP_CLOSURE_REORDER.pathPattern.test('project.loop_closures[1].id')).toBe(false);
  });

  it('exposes each known asymmetry with an id and an explanation', () => {
    for (const asymmetry of KNOWN_UNDO_ASYMMETRIES) {
      expect(asymmetry.id).toMatch(/^[a-z0-9-]+$/);
      expect(asymmetry.description.length).toBeGreaterThan(40);
    }
  });
});

describe('isListPermutationOnly', () => {
  const withClosures = (closures: unknown[], extra: Record<string, unknown> = {}): string =>
    canonicalJson({ project: { name: 'p', loop_closures: closures, ...extra }, stations: [] });

  const a = { id: 1, path_length: 10 };
  const b = { id: 2, path_length: 20 };
  const c = { id: 3, path_length: 30 };

  it('recognises the closure that was pushed back on instead of reinserted', () => {
    // Remove id 2 from [1,2,3] then undo: it lands at the end.
    const before = withClosures([a, b, c]);
    const afterUndo = withClosures([a, c, b]);

    expect(isListPermutationOnly(before, afterUndo, LOOP_CLOSURES_PATH)).toBe(true);
  });

  it('is false when a closure actually changed', () => {
    const before = withClosures([a, b, c]);
    const mutated = withClosures([a, c, { id: 2, path_length: 999 }]);

    expect(isListPermutationOnly(before, mutated, LOOP_CLOSURES_PATH)).toBe(false);
  });

  it('is false when a closure was lost or gained', () => {
    expect(isListPermutationOnly(withClosures([a, b, c]), withClosures([a, c]), LOOP_CLOSURES_PATH)).toBe(false);
    expect(isListPermutationOnly(withClosures([a, b]), withClosures([a, b, c]), LOOP_CLOSURES_PATH)).toBe(false);
  });

  it('is false when something OUTSIDE the list also differs', () => {
    const before = withClosures([a, b, c], { name_extra: 'x' });
    const after = withClosures([a, c, b], { name_extra: 'y' });

    expect(isListPermutationOnly(before, after, LOOP_CLOSURES_PATH)).toBe(false);
  });

  it('is false when the order is already identical', () => {
    const same = withClosures([a, b, c]);

    expect(isListPermutationOnly(same, same, LOOP_CLOSURES_PATH)).toBe(false);
  });

  it('is false when the path does not hold a list', () => {
    expect(isListPermutationOnly('{"project":{}}', '{"project":{}}', LOOP_CLOSURES_PATH)).toBe(false);
    expect(isListPermutationOnly('not json', 'not json', LOOP_CLOSURES_PATH)).toBe(false);
  });

  it('does not mistake a permutation for equality elsewhere in the snapshot', () => {
    // Reordered AND a station moved: not explainable by the reorder alone.
    const before = canonicalJson({ project: { loop_closures: [a, b] }, stations: [{ x: 1 }] });
    const after = canonicalJson({ project: { loop_closures: [b, a] }, stations: [{ x: 2 }] });

    expect(isListPermutationOnly(before, after, LOOP_CLOSURES_PATH)).toBe(false);
  });
});
