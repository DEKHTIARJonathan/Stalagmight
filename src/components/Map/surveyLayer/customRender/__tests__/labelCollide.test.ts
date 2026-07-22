import { describe, expect, it } from 'vitest';
import {
  collideLabels,
  labelScreenBox,
  labelPriority,
  placeGreedy,
  type CollisionInput,
} from '../labelCollide';
import type { LabelDescriptor } from '../labelTessellate';
import type { ExtentEm } from '../labelLayout';
import { LABEL_KIND, LABEL_FLAG, type LabelKind } from '../labelShaders';

/**
 * Screen-space label collision (#customRender labels, Phase 4). Pure, node env.
 * Locks: the place-first priority order, deterministic + pan-stable tie-break,
 * strict-boundary grid overlap, the "no two placed boxes overlap" invariant, and
 * the candidate filter (kind-visible / minzoom / decimation / reference-hide /
 * empty-extent) so collision only ever touches labels the shader draws.
 */

/** Identity projector: anchor-relative coords ARE the screen px (so a box is a
 *  simple function of extent × text-size + halo, easy to reason about). */
const IDENTITY: CollisionInput['project'] = (x, y) => [x, y];

function input(over: Partial<CollisionInput> = {}): CollisionInput {
  return {
    zoom: 18,
    project: IDENTITY,
    kindVisible: [true, true, true, true, true],
    hideReference: false,
    ...over,
  };
}

const UNIT_EXT: ExtentEm = { minX: 0, maxX: 1, minY: 0, maxY: 1 };

function desc(kind: LabelKind, over: Partial<LabelDescriptor> = {}): LabelDescriptor {
  return {
    kind,
    text: 'x',
    anchorX: 0,
    anchorY: 0,
    color: [0, 0, 0, 255],
    ordinal: 0,
    flags: 0,
    ...over,
  };
}

describe('labelPriority', () => {
  it('orders section > first-in-section station > station > shot > comments', () => {
    expect(labelPriority(LABEL_KIND.SECTION_NAME, false)).toBe(0);
    expect(labelPriority(LABEL_KIND.STATION_LABEL, true)).toBe(1);
    expect(labelPriority(LABEL_KIND.STATION_LABEL, false)).toBe(2);
    expect(labelPriority(LABEL_KIND.SHOT_LABEL, false)).toBe(3);
    expect(labelPriority(LABEL_KIND.STATION_COMMENT, false)).toBe(4);
    expect(labelPriority(LABEL_KIND.SHOT_COMMENT, false)).toBe(4);
  });
});

describe('collideLabels priority', () => {
  it('a section name wins over an overlapping shot label', () => {
    // Same anchor → boxes overlap; section (priority 0) placed, shot hidden.
    const descs = [desc(LABEL_KIND.SHOT_LABEL), desc(LABEL_KIND.SECTION_NAME)];
    const exts = [UNIT_EXT, UNIT_EXT];
    expect(collideLabels(descs, exts, input())).toEqual([0]); // the shot label loses
  });

  it('a first-in-section station wins over an overlapping ordinary station', () => {
    const descs = [
      desc(LABEL_KIND.STATION_LABEL, { ordinal: 2 }),
      desc(LABEL_KIND.STATION_LABEL, { ordinal: 3, flags: LABEL_FLAG.FIRST_IN_SECTION }),
    ];
    expect(collideLabels(descs, [UNIT_EXT, UNIT_EXT], input())).toEqual([0]);
  });
});

describe('collideLabels determinism + tie-break stability', () => {
  it('equal priority + ordinal resolves by array index (earlier wins), stably', () => {
    const descs = [
      desc(LABEL_KIND.SHOT_LABEL, { ordinal: 5 }),
      desc(LABEL_KIND.SHOT_LABEL, { ordinal: 5 }),
    ];
    const exts = [UNIT_EXT, UNIT_EXT];
    // Index 0 placed, index 1 loses — and repeatably.
    expect(collideLabels(descs, exts, input())).toEqual([1]);
    expect(collideLabels(descs, exts, input())).toEqual([1]);
  });

  it('is order-independent for the SURVIVING label (relative order preserved)', () => {
    const a = desc(LABEL_KIND.SHOT_LABEL, { ordinal: 5, anchorX: 100 });
    const b = desc(LABEL_KIND.SHOT_LABEL, { ordinal: 5, anchorX: 100 });
    // Whichever is earlier in the array survives; the later one is hidden.
    expect(collideLabels([a, b], [UNIT_EXT, UNIT_EXT], input())).toEqual([1]);
    expect(collideLabels([b, a], [UNIT_EXT, UNIT_EXT], input())).toEqual([1]);
  });
});

describe('collideLabels grid boundary', () => {
  it('boxes touching exactly at an edge do NOT collide (both placed)', () => {
    const left = desc(LABEL_KIND.SECTION_NAME, { anchorX: 0 });
    const box = labelScreenBox(left, UNIT_EXT, input());
    const style = { halo: 1.5 }; // section-name halo; box.minX = anchorX + 0 - halo
    // Place the second box so its LEFT edge == the first box's RIGHT edge.
    const right = desc(LABEL_KIND.SECTION_NAME, { anchorX: box.maxX + style.halo });
    expect(collideLabels([left, right], [UNIT_EXT, UNIT_EXT], input())).toEqual([]);
  });

  it('boxes overlapping by an epsilon DO collide (second loses)', () => {
    const left = desc(LABEL_KIND.SECTION_NAME, { anchorX: 0 });
    const box = labelScreenBox(left, UNIT_EXT, input());
    const right = desc(LABEL_KIND.SECTION_NAME, { anchorX: box.maxX + 1.5 - 0.01 });
    expect(collideLabels([left, right], [UNIT_EXT, UNIT_EXT], input())).toEqual([1]);
  });

  it('respects a custom cell size (correctness is cell-size independent)', () => {
    // Section (index 0, priority 0) placed; overlapping shot (index 1) loses,
    // regardless of the grid granularity.
    const descs = [desc(LABEL_KIND.SECTION_NAME), desc(LABEL_KIND.SHOT_LABEL)];
    const exts = [UNIT_EXT, UNIT_EXT];
    expect(collideLabels(descs, exts, input({ cellSize: 4 }))).toEqual([1]);
    expect(collideLabels(descs, exts, input({ cellSize: 512 }))).toEqual([1]);
  });
});

describe('collideLabels no-overlap invariant', () => {
  it('no two PLACED boxes overlap over a dense cluster', () => {
    const descs: LabelDescriptor[] = [];
    const exts: ExtentEm[] = [];
    // A 6x6 grid of shot labels 8px apart — boxes (~12px wide at z18) overlap
    // neighbours, so many must be culled.
    let ord = 0;
    for (let gx = 0; gx < 6; gx++) {
      for (let gy = 0; gy < 6; gy++) {
        descs.push(desc(LABEL_KIND.SHOT_LABEL, { anchorX: gx * 8, anchorY: gy * 8, ordinal: ord++ }));
        exts.push(UNIT_EXT);
      }
    }
    const inp = input();
    const hidden = new Set(collideLabels(descs, exts, inp));
    expect(hidden.size).toBeGreaterThan(0); // some culled
    const placed = descs.filter((_, i) => !hidden.has(i));
    const boxes = placed.map((d) => labelScreenBox(d, UNIT_EXT, inp));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
        expect(overlap).toBe(false);
      }
    }
  });

  it('well-separated labels are all placed', () => {
    const descs = [
      desc(LABEL_KIND.SHOT_LABEL, { anchorX: 0, ordinal: 0 }),
      desc(LABEL_KIND.SHOT_LABEL, { anchorX: 1000, ordinal: 1 }),
      desc(LABEL_KIND.SHOT_LABEL, { anchorX: 2000, ordinal: 2 }),
    ];
    expect(collideLabels(descs, [UNIT_EXT, UNIT_EXT, UNIT_EXT], input())).toEqual([]);
  });
});

describe('collideLabels candidate filter (matches the shader)', () => {
  it('skips a decimated-out label — it never causes a HIDE and is never hidden', () => {
    // zoom 15 → modulus 5. Shot ordinal 5 survives; ordinal 3 is decimated out.
    const descs = [
      desc(LABEL_KIND.SHOT_LABEL, { ordinal: 5 }),
      desc(LABEL_KIND.SHOT_LABEL, { ordinal: 3 }),
    ];
    // ordinal 3 is not a candidate, so despite overlapping ordinal 5 nothing hides.
    expect(collideLabels(descs, [UNIT_EXT, UNIT_EXT], input({ zoom: 15 }))).toEqual([]);
  });

  it('first-in-section station overrides decimation (still a candidate)', () => {
    const descs = [
      desc(LABEL_KIND.STATION_LABEL, { ordinal: 0, flags: LABEL_FLAG.FIRST_IN_SECTION }),
      desc(LABEL_KIND.STATION_LABEL, { ordinal: 3, flags: LABEL_FLAG.FIRST_IN_SECTION }),
    ];
    // Both survive decimation at z15; overlapping → the later one loses.
    expect(collideLabels(descs, [UNIT_EXT, UNIT_EXT], input({ zoom: 15 }))).toEqual([1]);
  });

  it('excludes a toggled-off kind from the candidate set', () => {
    const descs = [desc(LABEL_KIND.SECTION_NAME), desc(LABEL_KIND.SHOT_LABEL)];
    // Shot labels toggled off → not a candidate → not hidden, and cannot cull the section.
    const kindVisible = [false, true, true, true, true]; // shot off
    expect(collideLabels(descs, [UNIT_EXT, UNIT_EXT], input({ kindVisible }))).toEqual([]);
  });

  it('excludes labels below their kind minzoom', () => {
    // Shot minzoom 14; at zoom 13 neither shot label is a candidate.
    const descs = [desc(LABEL_KIND.SHOT_LABEL), desc(LABEL_KIND.SHOT_LABEL)];
    expect(collideLabels(descs, [UNIT_EXT, UNIT_EXT], input({ zoom: 13 }))).toEqual([]);
  });

  it('excludes reference / all-reference labels when reference shots are hidden', () => {
    const descs = [
      desc(LABEL_KIND.SECTION_NAME, { flags: LABEL_FLAG.ALL_REFERENCE }),
      desc(LABEL_KIND.SHOT_LABEL, { flags: LABEL_FLAG.REFERENCE }),
    ];
    expect(collideLabels(descs, [UNIT_EXT, UNIT_EXT], input({ hideReference: true }))).toEqual([]);
  });

  it('skips labels with no glyph extent (empty / whitespace)', () => {
    const descs = [desc(LABEL_KIND.SECTION_NAME), desc(LABEL_KIND.SHOT_LABEL)];
    // Section name has no extent → not a candidate → cannot cull the overlapping shot.
    expect(collideLabels(descs, [null, UNIT_EXT], input())).toEqual([]);
  });
});

describe('labelScreenBox', () => {
  it('sizes the box by extent × text-size + halo, flipping em +y up to screen +y down', () => {
    // Section name at z18: size 14, halo 1.5, extent {0..1, 0..1}.
    const box = labelScreenBox(
      desc(LABEL_KIND.SECTION_NAME, { anchorX: 10, anchorY: 20 }),
      { minX: 0, maxX: 1, minY: 0, maxY: 1 },
      input(),
    );
    expect(box.minX).toBeCloseTo(10 + 0 * 14 - 1.5, 6);
    expect(box.maxX).toBeCloseTo(10 + 1 * 14 + 1.5, 6);
    // em maxY (top) → screen minY: ay - maxY*size - halo.
    expect(box.minY).toBeCloseTo(20 - 1 * 14 - 1.5, 6);
    expect(box.maxY).toBeCloseTo(20 - 0 * 14 + 1.5, 6);
  });
});

describe('placeGreedy', () => {
  it('places the first, hides the second when boxes overlap', () => {
    const boxes = [
      { index: 0, priority: 0, tiebreak: 0, box: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
      { index: 1, priority: 1, tiebreak: 0, box: { minX: 5, minY: 5, maxX: 15, maxY: 15 } },
    ];
    expect(placeGreedy(boxes, 48)).toEqual([1]);
  });
});
