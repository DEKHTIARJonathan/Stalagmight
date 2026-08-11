import { describe, it, expect } from 'vitest';
import { computeTmlPreviewLayout } from '../tmlPreviewLayout';
import type { TmlFile, TmlSection, TmlShot } from '../../types/commands';

/**
 * The preview layout has one job the dialog depends on: agreeing with the Rust
 * converter about TOPOLOGY under a section selection. These drive the same
 * cases as `import_options.rs`'s tests, from the other side of the wire.
 */

function shot(id: number, fromId: number, over: Partial<TmlShot> = {}): TmlShot {
  return {
    id: BigInt(id),
    from_id: BigInt(fromId),
    shot_type: 'Real',
    azimuth: 90,
    length: 10,
    depth: 0,
    depth_in: 0,
    inclination: 0,
    left: 0,
    right: 0,
    up: 0,
    down: 0,
    comment: null,
    explorer: null,
    date: null,
    color: '#ff0000',
    excluded: false,
    latitude: 0,
    longitude: 0,
    closure_to_id: -1n,
    section: '',
    ...over,
  };
}

function section(name: string, startArianeId: number, shots: TmlShot[]): TmlSection {
  return {
    name,
    shots,
    surveyor: null,
    date: null,
    color: '#ff0000',
    is_branch_split: false,
    start_ariane_id: BigInt(startArianeId),
    end_ariane_id: shots.length > 0 ? shots[shots.length - 1]!.id : -1n,
    start_depth: 0,
  };
}

function file(sections: TmlSection[]): TmlFile {
  return {
    cave_name: 'T',
    unit: 'Metric',
    use_magnetic_azimuth: false,
    first_start_absolute_elevation: 0,
    geo_coding: null,
    sections,
    closures: [],
  };
}

/** A -> B -> C, each hanging off the previous section's last shot. Every shot
 *  runs due east, 10 m, so offsets are exact whole numbers. */
function chainOfThree(): TmlFile {
  return file([
    section('A', 0, [shot(1, 0), shot(2, 1)]),
    section('B', 2, [shot(3, 2), shot(4, 3)]),
    section('C', 4, [shot(5, 4), shot(6, 5)]),
  ]);
}

const all = { includeExcluded: false, selected: null };

/** Offsets to whole millimetres. Every fixture runs due east, where `cos(90 deg)`
 *  is 6e-17 rather than 0, and that noise is not what these tests are about. */
const mm = (v: number) => Math.round(v * 1000) / 1000;
const offsets = (layout: { sections: Array<{ offsetX: number; offsetY: number }> }) =>
  layout.sections.map((s) => [mm(s.offsetX), mm(s.offsetY)]);

describe('computeTmlPreviewLayout', () => {
  it('chains the sections end to end when nothing is filtered', () => {
    const layout = computeTmlPreviewLayout(chainOfThree(), all);

    expect(layout.sections.map((s) => s.index)).toEqual([0, 1, 2]);
    // A at the origin; B starts where A's 2 shots ended (20 m east); C at 40.
    expect(offsets(layout)).toEqual([
      [0, 0],
      [20, 0],
      [40, 0],
    ]);
    expect(layout.reanchoredCount).toBe(0);
  });

  it('drops a deselected section and re-anchors the first survivor to the origin', () => {
    const layout = computeTmlPreviewLayout(chainOfThree(), {
      includeExcluded: false,
      selected: new Set([1, 2]),
    });

    expect(layout.sections.map((s) => s.index)).toEqual([1, 2]);
    // B is the new root, so it moves to the origin and C follows it there.
    expect(offsets(layout)).toEqual([
      [0, 0],
      [20, 0],
    ]);
    // The new root belongs at the origin - that is not a lost anchor.
    expect(layout.reanchoredCount).toBe(0);
    expect(layout.sections.every((s) => !s.reanchored)).toBe(true);
  });

  it('counts a section whose parent was deselected as re-anchored', () => {
    const layout = computeTmlPreviewLayout(chainOfThree(), {
      includeExcluded: false,
      selected: new Set([0, 2]),
    });

    expect(layout.sections.map((s) => s.index)).toEqual([0, 2]);
    const c = layout.sections.find((s) => s.index === 2)!;
    expect(c.reanchored).toBe(true);
    expect([mm(c.offsetX), mm(c.offsetY)]).toEqual([0, 0]);
    expect(layout.reanchoredCount).toBe(1);
  });

  it('resolves a parent that appears later in the file', () => {
    // Section 1 hangs off the last shot of section 2: a FORWARD reference,
    // which a single resolution pass in file order would leave at the origin
    // (section 2 is not placed yet when section 1 is visited). Section 0 is the
    // root, so this is not the root rule doing the work.
    const tml = file([
      section('A', 0, [shot(1, 0), shot(2, 1)]),
      section('Forward child', 6, [shot(7, 6)]),
      section('C', 2, [shot(5, 2), shot(6, 5)]),
    ]);
    const layout = computeTmlPreviewLayout(tml, all);

    const c = layout.sections.find((s) => s.index === 2)!;
    expect([mm(c.offsetX), mm(c.offsetY)]).toEqual([20, 0]);
    const child = layout.sections.find((s) => s.index === 1)!;
    // C sits 20 m east and runs 20 m further, so its station 2 is at 40.
    expect([mm(child.offsetX), mm(child.offsetY)]).toEqual([40, 0]);
    expect(child.reanchored).toBe(false);
  });

  it('leaves a self-referential cycle at the origin instead of looping', () => {
    // Two sections that each claim to start at the other's last shot.
    const tml = file([
      section('Loop A', 30, [shot(20, 30)]),
      section('Loop B', 20, [shot(30, 20)]),
    ]);
    const layout = computeTmlPreviewLayout(tml, all);
    expect(layout.sections).toHaveLength(2);
    for (const s of layout.sections) {
      expect(Number.isFinite(s.offsetX)).toBe(true);
      expect(Number.isFinite(s.offsetY)).toBe(true);
    }
  });

  it('omits a section left with no shots by the exclusion filter', () => {
    const tml = file([
      section('A', 0, [shot(1, 0)]),
      section('Excluded', 1, [shot(2, 1, { excluded: true })]),
    ]);

    expect(computeTmlPreviewLayout(tml, all).sections.map((s) => s.index)).toEqual([0]);
    expect(
      computeTmlPreviewLayout(tml, { includeExcluded: true, selected: null }).sections.map(
        (s) => s.index
      )
    ).toEqual([0, 1]);
  });

  it('lays out nothing for an empty selection', () => {
    const layout = computeTmlPreviewLayout(chainOfThree(), {
      includeExcluded: false,
      selected: new Set(),
    });
    expect(layout.sections).toEqual([]);
    expect(layout.reanchoredCount).toBe(0);
  });

  it('keeps CLOSURE rows out of the drawn geometry', () => {
    const tml = file([
      section('A', 0, [shot(1, 0), shot(9, 1, { shot_type: 'Closure', closure_to_id: 1n })]),
    ]);
    const layout = computeTmlPreviewLayout(tml, all);
    expect(layout.sections[0]!.section.shots).toHaveLength(1);
  });
});
