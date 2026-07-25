import { describe, expect, it } from 'vitest';
import {
  computeRevealZooms,
  revealScreenBox,
  labelPriority,
  emitSlackFor,
  REVEAL_NEVER,
  EMIT_SLACK,
  REVEAL_CEILING,
  ADAPTIVE_EMIT_MAX,
  type RevealInput,
  type ScreenBox,
} from '../labelReveal';
import type { LabelDescriptor } from '../labelTessellate';
import type { ExtentEm } from '../labelLayout';
import { LABEL_KIND, LABEL_FLAG, type LabelKind } from '../labelShaders';
import { LABEL_KIND_STYLE, interpolateStops } from '../labelStyle';

/**
 * Per-label reveal-zoom computation (#customRender labels, reveal-zoom rework).
 * Pure, node env. Locks: the fold of decimation-admission + collision into one
 * reveal zoom, the zoom-independent priority order (coarser tier / higher kind
 * priority wins), determinism (same input → same output, and stable across
 * rebuilds whose membership shifts), the candidate filter (toggled-off /
 * reference-hidden / empty labels), and - the headline property - MONOTONICITY:
 * the visible set only grows with zoom and never overlaps at any zoom.
 */

const UNIT_EXT: ExtentEm = { minX: 0, maxX: 1, minY: 0, maxY: 1 };

/** buildZoom 18, a large world-pixel scale so a small mercator delta is many px.
 *  slack default 2 → ladder covers up to z20 unless overridden. */
function input(over: Partial<RevealInput> = {}): RevealInput {
  return {
    buildZoom: 18,
    worldPixelScale: 1e6,
    kindVisible: [true, true, true, true, true],
    hideReference: false,
    ...over,
  };
}

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

describe('computeRevealZooms decimation-admission fold', () => {
  it('an isolated shot reveals at its nested tier floor: %4 -> 14, %2 -> 16, odd -> 18', () => {
    // Far-apart shots never collide, so reveal == the decimation admission zoom.
    const descs = [
      desc(LABEL_KIND.SHOT_LABEL, { anchorX: 0, ordinal: 4 }), // tier 0
      desc(LABEL_KIND.SHOT_LABEL, { anchorX: 0.01, ordinal: 2 }), // tier 1
      desc(LABEL_KIND.SHOT_LABEL, { anchorX: 0.02, ordinal: 1 }), // tier 2
    ];
    const reveal = computeRevealZooms(descs, [UNIT_EXT, UNIT_EXT, UNIT_EXT], input());
    expect(Array.from(reveal)).toEqual([14, 16, 18]);
  });

  it('a first-in-section station reveals at its minzoom regardless of ordinal', () => {
    const descs = [desc(LABEL_KIND.STATION_LABEL, { anchorX: 0, ordinal: 7, flags: LABEL_FLAG.FIRST_IN_SECTION })];
    expect(computeRevealZooms(descs, [UNIT_EXT], input())[0]).toBe(14);
  });
});

describe('computeRevealZooms priority (coincident labels)', () => {
  it('a section name reveals; a coincident shot is pushed past the horizon (never)', () => {
    // Same anchor → boxes overlap at every zoom (0 separation), so only the
    // higher-priority section can ever reveal.
    const descs = [desc(LABEL_KIND.SHOT_LABEL, { ordinal: 0 }), desc(LABEL_KIND.SECTION_NAME)];
    const reveal = computeRevealZooms(descs, [UNIT_EXT, UNIT_EXT], input());
    expect(reveal[1]).toBe(10); // section at its minzoom
    expect(reveal[0]).toBe(REVEAL_NEVER); // coincident shot never clears
  });

  it('a first-in-section station beats a coincident ordinary station', () => {
    const descs = [
      desc(LABEL_KIND.STATION_LABEL, { ordinal: 2 }), // ordinary (tier 1, admit 16)
      desc(LABEL_KIND.STATION_LABEL, { ordinal: 7, flags: LABEL_FLAG.FIRST_IN_SECTION }), // admit 14, priority 1
    ];
    const reveal = computeRevealZooms(descs, [UNIT_EXT, UNIT_EXT], input());
    expect(reveal[1]).toBe(14);
    expect(reveal[0]).toBe(REVEAL_NEVER);
  });
});

describe('computeRevealZooms determinism', () => {
  it('is deterministic: identical inputs → identical output', () => {
    const descs = [
      desc(LABEL_KIND.SHOT_LABEL, { anchorX: 0, ordinal: 0, shotGlobal: 0 }),
      desc(LABEL_KIND.SHOT_LABEL, { anchorX: 0, ordinal: 0, shotGlobal: 1 }),
    ];
    const a = Array.from(computeRevealZooms(descs, [UNIT_EXT, UNIT_EXT], input()));
    const b = Array.from(computeRevealZooms(descs, [UNIT_EXT, UNIT_EXT], input()));
    expect(a).toEqual(b);
    // Exactly one of the coincident pair reveals (the lower stable id wins).
    expect(a.filter((r) => r !== REVEAL_NEVER)).toHaveLength(1);
  });

  it('resolves an unchanged neighbourhood identically when far-away membership changes', () => {
    // Determinism across rebuilds: adding a distant label must not perturb the
    // reveal zooms of an existing cluster (padding absorbs edge effects).
    const cluster = [
      desc(LABEL_KIND.SHOT_LABEL, { anchorX: 0, ordinal: 0, shotGlobal: 10 }),
      desc(LABEL_KIND.SHOT_LABEL, { anchorX: 0.000004, ordinal: 4, shotGlobal: 11 }),
      desc(LABEL_KIND.SHOT_LABEL, { anchorX: 0.000008, ordinal: 8, shotGlobal: 12 }),
    ];
    const exts = cluster.map(() => UNIT_EXT);
    const before = Array.from(computeRevealZooms(cluster, exts, input()));
    const withFarLabel = [
      ...cluster,
      desc(LABEL_KIND.SHOT_LABEL, { anchorX: 5, ordinal: 0, shotGlobal: 99 }),
    ];
    const after = Array.from(
      computeRevealZooms(withFarLabel, [...exts, UNIT_EXT], input()),
    );
    expect(after.slice(0, 3)).toEqual(before);
  });
});

describe('computeRevealZooms candidate filter (matches the shader gates)', () => {
  it('a toggled-off kind is NOT contested - it reveals at its floor and blocks nobody', () => {
    // Shot toggled off: it is emitted at its admission floor (so a later toggle-on
    // shows it without a rebuild) and does not cull the coincident section.
    const descs = [desc(LABEL_KIND.SECTION_NAME), desc(LABEL_KIND.SHOT_LABEL, { ordinal: 0 })];
    const kindVisible = [false, true, true, true, true]; // shot off
    const reveal = computeRevealZooms(descs, [UNIT_EXT, UNIT_EXT], input({ kindVisible }));
    expect(reveal[0]).toBe(10); // section still reveals at its minzoom
    expect(reveal[1]).toBe(14); // shot emitted uncontested at its floor
  });

  it('reference/all-reference labels are not contested when reference shots are hidden', () => {
    const descs = [
      desc(LABEL_KIND.SECTION_NAME, { flags: LABEL_FLAG.ALL_REFERENCE }),
      desc(LABEL_KIND.SHOT_LABEL, { flags: LABEL_FLAG.REFERENCE, ordinal: 0 }),
    ];
    const reveal = computeRevealZooms(descs, [UNIT_EXT, UNIT_EXT], input({ hideReference: true }));
    // Both are emitted at their floors (the shader hides them via u_hide_reference).
    expect(reveal[0]).toBe(10);
    expect(reveal[1]).toBe(14);
  });

  it('an empty (whitespace) label never reveals - no ink, never emitted', () => {
    const descs = [desc(LABEL_KIND.SECTION_NAME)];
    expect(computeRevealZooms(descs, [null], input())[0]).toBe(REVEAL_NEVER);
  });
});

describe('computeRevealZooms comment overlap-exempt (C1)', () => {
  it('exempt comment kinds reveal uncontested at their minzoom, blocking nobody', () => {
    // A shot comment coincident (0 separation) with a section name is normally
    // culled - lowest priority, always overlapping. Overlap-exempt: it reveals at
    // its floor (comment minzoom 14) and the section is unaffected.
    const descs = [desc(LABEL_KIND.SECTION_NAME), desc(LABEL_KIND.SHOT_COMMENT)];
    const culled = computeRevealZooms(descs, [UNIT_EXT, UNIT_EXT], input());
    expect(culled[1]).toBe(REVEAL_NEVER); // normally culled by the coincident section
    const exempt = computeRevealZooms(
      descs, [UNIT_EXT, UNIT_EXT], input({ commentOverlapExempt: true }),
    );
    expect(exempt[0]).toBe(10); // section unchanged (its minzoom)
    expect(exempt[1]).toBe(14); // comment now revealed uncontested at its floor
  });

  it('exempts ONLY comment kinds - a coincident non-comment label still collides', () => {
    // A shot LABEL coincident with a section name stays culled even with the
    // exemption on: the flag must not touch non-comment kinds.
    const descs = [desc(LABEL_KIND.SECTION_NAME), desc(LABEL_KIND.SHOT_LABEL, { ordinal: 0 })];
    const reveal = computeRevealZooms(
      descs, [UNIT_EXT, UNIT_EXT], input({ commentOverlapExempt: true }),
    );
    expect(reveal[0]).toBe(10);
    expect(reveal[1]).toBe(REVEAL_NEVER); // non-comment: unchanged, still culled
  });

  it('both comment kinds reveal even when coincident with each other', () => {
    const descs = [desc(LABEL_KIND.STATION_COMMENT), desc(LABEL_KIND.SHOT_COMMENT)];
    const reveal = computeRevealZooms(
      descs, [UNIT_EXT, UNIT_EXT], input({ commentOverlapExempt: true }),
    );
    expect(reveal[0]).toBe(14);
    expect(reveal[1]).toBe(14);
  });
});

describe('emitSlackFor (adaptive emit horizon)', () => {
  it('returns the bounded EMIT_SLACK when the candidate set exceeds the threshold', () => {
    expect(emitSlackFor(ADAPTIVE_EMIT_MAX + 1, 15)).toBe(EMIT_SLACK);
  });

  it('runs the ladder to the ceiling when the set is at/below the threshold', () => {
    expect(emitSlackFor(ADAPTIVE_EMIT_MAX, 15)).toBe(REVEAL_CEILING - 15);
    expect(emitSlackFor(10, 17)).toBe(REVEAL_CEILING - 17);
  });

  it('never returns below EMIT_SLACK, even at/above the ceiling zoom', () => {
    expect(emitSlackFor(10, REVEAL_CEILING)).toBe(EMIT_SLACK);
    expect(emitSlackFor(10, REVEAL_CEILING + 3)).toBe(EMIT_SLACK);
  });

  it('threshold override forces either branch (used by the controller tests)', () => {
    expect(emitSlackFor(5, 15, 0)).toBe(EMIT_SLACK); // 5 > 0 → bounded
    expect(emitSlackFor(5, 15, 10)).toBe(REVEAL_CEILING - 15); // 5 <= 10 → adaptive
  });
});

describe('computeRevealZooms adaptive ceiling emits high-reveal labels', () => {
  it('a band-edge label past the bounded horizon is emitted when the ladder runs to the ceiling', () => {
    // Built at z15. An isolated odd (tier 2) shot admits at z18 - past the bounded
    // horizon 17 (15 + EMIT_SLACK) but within the adaptive ladder. Bounded →
    // REVEAL_NEVER (dropped, appears only after a rebuild); adaptive → reveal 18
    // (emitted, admitted per-frame by the shader as the live zoom reaches 18).
    const descs = [desc(LABEL_KIND.SHOT_LABEL, { ordinal: 1, anchorX: 0 })];
    const bounded = computeRevealZooms(descs, [UNIT_EXT], input({ buildZoom: 15, slack: EMIT_SLACK }));
    expect(bounded[0]).toBe(REVEAL_NEVER);
    const adaptive = computeRevealZooms(descs, [UNIT_EXT], input({ buildZoom: 15, slack: emitSlackFor(1, 15) }));
    expect(adaptive[0]).toBe(18);
  });
});

describe('computeRevealZooms emit horizon (slack)', () => {
  it('drops a non-candidate whose floor is past buildZoom + slack (not emitted)', () => {
    // buildZoom 14, slack 1 → horizon 15. An odd (tier 2, admit 18) toggled-off
    // shot is past the horizon → REVEAL_NEVER.
    const descs = [desc(LABEL_KIND.SHOT_LABEL, { ordinal: 1 })];
    const reveal = computeRevealZooms(
      descs,
      [UNIT_EXT],
      input({ buildZoom: 14, slack: 1, kindVisible: [false, false, false, false, false] }),
    );
    expect(reveal[0]).toBe(REVEAL_NEVER);
  });
});

// ─── Monotonicity property (the headline correctness guarantee) ───────────────

/** Deterministic LCG so the randomized property test is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function boxAt(d: LabelDescriptor, ext: ExtentEm, z: number, buildZoom: number, wpsBuild: number): ScreenBox {
  const wps = wpsBuild * 2 ** (z - buildZoom);
  const style = LABEL_KIND_STYLE[d.kind];
  const size = interpolateStops(z, style.size);
  return revealScreenBox(d, ext, wps, size, style.haloWidth);
}

function boxesOverlap(a: ScreenBox, b: ScreenBox): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

describe('computeRevealZooms MONOTONICITY (randomized zoom sweep)', () => {
  it('for a fixed build the visible set only GROWS with zoom and never overlaps', () => {
    const rnd = lcg(0xc0ffee);
    const kinds: LabelKind[] = [
      LABEL_KIND.SECTION_NAME,
      LABEL_KIND.STATION_LABEL,
      LABEL_KIND.SHOT_LABEL,
      LABEL_KIND.STATION_COMMENT,
    ];
    const descs: LabelDescriptor[] = [];
    const exts: ExtentEm[] = [];
    for (let i = 0; i < 120; i++) {
      const kind = kinds[Math.floor(rnd() * kinds.length)]!;
      const over: Partial<LabelDescriptor> = {
        // A tight cluster (small mercator span) so there is REAL collision at low
        // zoom that clears as the camera zooms in.
        anchorX: rnd() * 0.0008,
        anchorY: rnd() * 0.0008,
        ordinal: Math.floor(rnd() * 40),
        flags: rnd() < 0.15 ? LABEL_FLAG.FIRST_IN_SECTION : 0,
        sectionId: i,
      };
      // A distinct stable id per label (viewport-independent), set on the field
      // that matches the kind - avoids passing `undefined` under exactOptionalPropertyTypes.
      if (kind === LABEL_KIND.SHOT_LABEL) over.shotGlobal = i;
      else if (kind === LABEL_KIND.STATION_LABEL) over.stationGlobal = i;
      descs.push(desc(kind, over));
      exts.push(UNIT_EXT);
    }
    // buildZoom high + generous slack so the ladder computes reveals across the
    // whole sweep range (10..22), and a small wps forces low-zoom collision.
    const buildZoom = 22;
    const wps = 4e6;
    const reveal = computeRevealZooms(descs, exts, input({ buildZoom, worldPixelScale: wps, slack: 2 }));

    let prevVisible = new Set<number>();
    for (let z = 10; z <= 22 + 1e-9; z += 0.5) {
      const visible: number[] = [];
      for (let i = 0; i < descs.length; i++) {
        if (reveal[i]! !== REVEAL_NEVER && reveal[i]! <= z + 1e-9) visible.push(i);
      }
      // (a) MONOTONE: every label visible at a lower zoom stays visible.
      for (const i of prevVisible) expect(visible).toContain(i);
      // (b) NO OVERLAP among the visible set at this exact zoom.
      const boxes = visible.map((i) => boxAt(descs[i]!, exts[i]!, z, buildZoom, wps));
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          expect(boxesOverlap(boxes[a]!, boxes[b]!)).toBe(false);
        }
      }
      prevVisible = new Set(visible);
    }
    // The sweep actually admitted labels over time (not all-at-once / none).
    expect(prevVisible.size).toBeGreaterThan(0);
  });
});
