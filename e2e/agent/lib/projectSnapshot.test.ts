import { describe, expect, it } from 'vitest';

import {
  KNOWN_UNDO_ASYMMETRIES,
  LOOP_CLOSURES_PATH,
  LOOP_CLOSURE_REORDER,
  SAVE_HEALING_MUTATIONS,
  canonicalJson,
  classifyDiffs,
  describeDiffs,
  diffJson,
  diffSnapshots,
  isBug8ShotSwapOnly,
  isListPermutationOnly,
  isShotIdentitySwap,
  shotSetDelta,
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

describe('SAVE_HEALING_MUTATIONS', () => {
  it('accepts the three documented save-time heals, in the documented direction', () => {
    const classified = classifyDiffs(
      [
        { path: 'project.sections[2].gauge_shot_uuid', expected: 'null', actual: '"u-1"' },
        { path: 'project.sections[2].gauge_neighbour_uuid', expected: 'null', actual: '"u-2"' },
        { path: 'project.sections[0].shots[1].uuid', expected: '<absent>', actual: '"u-3"' },
        { path: 'project.section_offsets.9', expected: '[0,0]', actual: '<absent>' },
      ],
      SAVE_HEALING_MUTATIONS,
    );

    expect(classified.unknown).toEqual([]);
    expect(classified.asymmetries).toHaveLength(3);
  });

  it('rejects the same paths moving the WRONG way', () => {
    const classified = classifyDiffs(
      [
        // A gauge anchor changing value (not null -> value) is not a heal.
        { path: 'project.sections[2].gauge_shot_uuid', expected: '"old"', actual: '"new"' },
        // An offset entry APPEARING is not the orphan retain.
        { path: 'project.section_offsets.9', expected: '<absent>', actual: '[1,2]' },
        // A uuid being cleared is not the backfill.
        { path: 'project.sections[0].shots[1].uuid', expected: '"u"', actual: '<absent>' },
      ],
      SAVE_HEALING_MUTATIONS,
    );

    expect(classified.known).toEqual([]);
    expect(classified.unknown).toHaveLength(3);
  });

  it('rejects anything else a save might have touched', () => {
    const classified = classifyDiffs(
      [{ path: 'project.sections[0].shots[1].length', expected: '5', actual: '6' }],
      SAVE_HEALING_MUTATIONS,
    );

    expect(classified.unknown).toHaveLength(1);
  });
});

describe('shotSetDelta', () => {
  const snapshot = (sections: { id: number; uuids: string[] }[]): string =>
    canonicalJson({
      project: {
        sections: sections.map((section) => ({
          id: section.id,
          shots: section.uuids.map((uuid) => ({ uuid })),
        })),
      },
      stations: [],
    });

  it('is empty when the same shots are present on both sides', () => {
    const same = snapshot([{ id: 1, uuids: ['a', 'b'] }]);

    expect(shotSetDelta(same, same)).toEqual([]);
    // Reordered within the section: the same shots moved, none was lost.
    expect(shotSetDelta(same, snapshot([{ id: 1, uuids: ['b', 'a'] }]))).toEqual([]);
  });

  it('names the shot that went missing and the one that took its place', () => {
    const deltas = shotSetDelta(
      snapshot([{ id: 1, uuids: ['a', 'b'] }]),
      snapshot([{ id: 1, uuids: ['a', 'c'] }]),
    );

    expect(deltas).toEqual([
      { sectionId: 1, missing: ['b'], extra: ['c'], expectedCount: 2, actualCount: 2 },
    ]);
  });

  it('counts a section that VANISHED as its whole shot list lost', () => {
    // The regression this guards: iterating only `expected` and skipping ids
    // absent from `actual` reported NO delta for a run that lost a section, and
    // the caller then printed "shot identity is IDENTICAL on both sides".
    const deltas = shotSetDelta(
      snapshot([{ id: 1, uuids: ['a'] }, { id: 7, uuids: ['x', 'y'] }]),
      snapshot([{ id: 1, uuids: ['a'] }]),
    );

    expect(deltas).toEqual([
      { sectionId: 7, missing: ['x', 'y'], extra: [], expectedCount: 2, actualCount: 0 },
    ]);
  });

  it('counts a section that APPEARED as its whole shot list gained', () => {
    const deltas = shotSetDelta(
      snapshot([{ id: 1, uuids: ['a'] }]),
      snapshot([{ id: 1, uuids: ['a'] }, { id: 7, uuids: ['x'] }]),
    );

    expect(deltas).toEqual([
      { sectionId: 7, missing: [], extra: ['x'], expectedCount: 0, actualCount: 1 },
    ]);
  });
});

describe('isBug8ShotSwapOnly', () => {
  // Section id 4 sits at index 1, so its diffs are `project.sections[1]....`.
  const expected = canonicalJson({
    project: {
      sections: [
        { id: 2, shots: [{ uuid: 'p' }] },
        { id: 4, shots: [{ uuid: 'a' }, { uuid: 'b' }] },
      ],
    },
    stations: [],
  });
  const actual = canonicalJson({
    project: {
      sections: [
        { id: 2, shots: [{ uuid: 'p' }] },
        { id: 4, shots: [{ uuid: 'a' }, { uuid: 'c' }] },
      ],
    },
    stations: [],
  });
  const deltas = shotSetDelta(expected, actual);

  it('agrees with isShotIdentitySwap on the uuid shape', () => {
    expect(isShotIdentitySwap(deltas)).toBe(true);
  });

  it('is true when every remaining diff is inside the swapped section', () => {
    const diffs = [
      { path: 'project.sections[1].shots[1].uuid', expected: '"b"', actual: '"c"' },
      { path: 'project.sections[1].shots[1].length', expected: '5', actual: '6' },
    ];

    expect(isBug8ShotSwapOnly(diffs, deltas, expected)).toBe(true);
  });

  it('is true for the geometry the swapped section feeds', () => {
    const diffs = [
      { path: 'stations[3].coordinates.x', expected: '1', actual: '2' },
      { path: 'project.section_offsets.4', expected: '[0,0]', actual: '[1,1]' },
      { path: 'stats.total_length', expected: '10', actual: '9' },
    ];

    expect(isBug8ShotSwapOnly(diffs, deltas, expected)).toBe(true);
  });

  it('is FALSE when something outside the swapped section also differs', () => {
    // The whole point: a lost comment in ANOTHER section rode along with a
    // genuine swap, was reported as bug 8, and was resynced away unseen.
    expect(
      isBug8ShotSwapOnly(
        [{ path: 'project.sections[0].shots[0].comment', expected: '"note"', actual: 'null' }],
        deltas,
        expected,
      ),
    ).toBe(false);
    expect(
      isBug8ShotSwapOnly(
        [{ path: 'project.loop_closures.length', expected: '2', actual: '1' }],
        deltas,
        expected,
      ),
    ).toBe(false);
    // A count moving is structural, and bug 8 does not move counts.
    expect(
      isBug8ShotSwapOnly([{ path: 'stats.total_shots', expected: '9', actual: '8' }], deltas, expected),
    ).toBe(false);
  });

  it('is false when the uuid shape is not a single swap', () => {
    const lost = shotSetDelta(
      expected,
      canonicalJson({
        project: {
          sections: [
            { id: 2, shots: [{ uuid: 'p' }] },
            { id: 4, shots: [{ uuid: 'a' }] },
          ],
        },
        stations: [],
      }),
    );

    expect(isBug8ShotSwapOnly([], lost, expected)).toBe(false);
    expect(isBug8ShotSwapOnly([], [], expected)).toBe(false);
  });

  it('is false when the swapped section is not in the snapshot it was given', () => {
    expect(isBug8ShotSwapOnly([], deltas, '{"project":{"sections":[]}}')).toBe(false);
    expect(isBug8ShotSwapOnly([], deltas, 'not json')).toBe(false);
  });
});
