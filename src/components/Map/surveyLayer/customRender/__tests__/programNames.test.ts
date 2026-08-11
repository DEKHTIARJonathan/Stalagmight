import { describe, expect, it } from 'vitest';
import {
  LINE_UNIFORMS,
  LINE_ATTRIBS,
  CIRCLE_UNIFORMS,
  CIRCLE_ATTRIBS,
} from '../surveyCustomLayer';
import { LABEL_UNIFORMS, LABEL_ATTRIBS } from '../surveyCustomLabelLayer';
import {
  GHOST_LINE_UNIFORMS,
  GHOST_LINE_ATTRIBS,
  GHOST_CIRCLE_UNIFORMS,
  GHOST_CIRCLE_ATTRIBS,
} from '../surveyGhostLayer';
import {
  MEASURE_LINE_UNIFORMS,
  MEASURE_LINE_ATTRIBS,
  MEASURE_CIRCLE_UNIFORMS,
  MEASURE_CIRCLE_ATTRIBS,
} from '../surveyMeasurePathLayer';
import {
  LINE_VERTEX_SRC,
  LINE_FRAGMENT_SRC,
  CIRCLE_VERTEX_SRC,
  CIRCLE_FRAGMENT_SRC,
} from '../shaders';
import { LABEL_VERTEX_SRC, LABEL_FRAGMENT_SRC } from '../labelShaders';
import {
  GHOST_LINE_VERTEX_SRC,
  GHOST_LINE_FRAGMENT_SRC,
  GHOST_CIRCLE_VERTEX_SRC,
  GHOST_CIRCLE_FRAGMENT_SRC,
} from '../ghostShaders';
import {
  MEASURE_LINE_VERTEX_SRC,
  MEASURE_LINE_FRAGMENT_SRC,
  MEASURE_CIRCLE_VERTEX_SRC,
  MEASURE_CIRCLE_FRAGMENT_SRC,
} from '../measurePathShaders';
import { declaredUniforms, declaredAttribs } from './shaderDecls';

/** Set comparison as a sorted array, so a mismatch prints the missing name. */
const asSet = (names: readonly string[]): string[] => [...new Set(names)].sort();

describe('surveyCustomLayer program name lists match the GLSL (#339)', () => {
  it('LINE_UNIFORMS covers every uniform the line program declares', () => {
    // Union: the fragment shader re-declares u_half_width / u_aa, and a uniform
    // declared in either stage is one location on the linked program.
    const declared = [...declaredUniforms(LINE_VERTEX_SRC), ...declaredUniforms(LINE_FRAGMENT_SRC)];
    expect(asSet(LINE_UNIFORMS)).toEqual(asSet(declared));
  });

  it('LINE_ATTRIBS covers every attribute the line vertex shader declares', () => {
    expect(asSet(LINE_ATTRIBS)).toEqual(asSet(declaredAttribs(LINE_VERTEX_SRC)));
  });

  it('CIRCLE_UNIFORMS covers every uniform the circle program declares', () => {
    const declared = [
      ...declaredUniforms(CIRCLE_VERTEX_SRC),
      ...declaredUniforms(CIRCLE_FRAGMENT_SRC),
    ];
    expect(asSet(CIRCLE_UNIFORMS)).toEqual(asSet(declared));
  });

  it('CIRCLE_ATTRIBS covers every attribute the circle vertex shader declares', () => {
    expect(asSet(CIRCLE_ATTRIBS)).toEqual(asSet(declaredAttribs(CIRCLE_VERTEX_SRC)));
  });

  it('no list repeats a name (a duplicate would waste a location query)', () => {
    for (const names of [LINE_UNIFORMS, LINE_ATTRIBS, CIRCLE_UNIFORMS, CIRCLE_ATTRIBS]) {
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('the scraper sees the counts the location cache is sized for', () => {
    // Guards the regexes themselves: an over-permissive pattern that matched
    // nothing (or matched varyings) would make the set-equality tests vacuous.
    expect(LINE_UNIFORMS.length).toBe(8);
    expect(LINE_ATTRIBS.length).toBe(10);
    expect(CIRCLE_UNIFORMS.length).toBe(9);
    expect(CIRCLE_ATTRIBS.length).toBe(9);
    expect(declaredAttribs(LINE_FRAGMENT_SRC)).toEqual([]);
    expect(declaredAttribs(CIRCLE_FRAGMENT_SRC)).toEqual([]);
  });
});

describe('surveyCustomLabelLayer program name lists match the GLSL (#339)', () => {
  it('LABEL_UNIFORMS covers every uniform the label program declares', () => {
    // Union: the sampler + SDF metrics are fragment-only, the geometry uniforms
    // vertex-only, and a uniform declared in either stage is one location on the
    // linked program.
    const declared = [
      ...declaredUniforms(LABEL_VERTEX_SRC),
      ...declaredUniforms(LABEL_FRAGMENT_SRC),
    ];
    expect(asSet(LABEL_UNIFORMS)).toEqual(asSet(declared));
  });

  it('LABEL_ATTRIBS covers every attribute the label vertex shader declares', () => {
    expect(asSet(LABEL_ATTRIBS)).toEqual(asSet(declaredAttribs(LABEL_VERTEX_SRC)));
  });

  it('no list repeats a name (a duplicate would waste a location query)', () => {
    for (const names of [LABEL_UNIFORMS, LABEL_ATTRIBS]) {
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('the scraper sees the counts the location cache is sized for', () => {
    expect(LABEL_UNIFORMS.length).toBe(14);
    expect(LABEL_ATTRIBS.length).toBe(7);
    expect(declaredAttribs(LABEL_FRAGMENT_SRC)).toEqual([]);
  });

  it('the per-kind array uniforms are cached under their BARE names', () => {
    // The layer queried `u_text_size_px`, not `u_text_size_px[0]`, before the
    // cache existed; the cached string must stay byte-identical or the location
    // silently becomes null. The scraper stops at the `[`, so the pin above
    // compares bare name to bare name.
    const arrays = ['u_text_size_px', 'u_opacity', 'u_kind_visible', 'u_halo_color', 'u_halo_width_px'];
    for (const name of arrays) {
      expect(declaredUniforms(LABEL_VERTEX_SRC).concat(declaredUniforms(LABEL_FRAGMENT_SRC)))
        .toContain(name);
      expect(LABEL_UNIFORMS).toContain(name);
    }
    expect(LABEL_UNIFORMS.some((n) => n.includes('['))).toBe(false);
  });
});

describe('surveyGhostLayer program name lists match the GLSL (#339)', () => {
  it('GHOST_LINE_UNIFORMS covers every uniform the line program declares', () => {
    const declared = [
      ...declaredUniforms(GHOST_LINE_VERTEX_SRC),
      ...declaredUniforms(GHOST_LINE_FRAGMENT_SRC),
    ];
    expect(asSet(GHOST_LINE_UNIFORMS)).toEqual(asSet(declared));
  });

  it('GHOST_LINE_ATTRIBS covers every attribute the line vertex shader declares', () => {
    expect(asSet(GHOST_LINE_ATTRIBS)).toEqual(asSet(declaredAttribs(GHOST_LINE_VERTEX_SRC)));
  });

  it('GHOST_CIRCLE_UNIFORMS covers every uniform the circle program declares', () => {
    const declared = [
      ...declaredUniforms(GHOST_CIRCLE_VERTEX_SRC),
      ...declaredUniforms(GHOST_CIRCLE_FRAGMENT_SRC),
    ];
    expect(asSet(GHOST_CIRCLE_UNIFORMS)).toEqual(asSet(declared));
  });

  it('GHOST_CIRCLE_ATTRIBS covers every attribute the circle vertex shader declares', () => {
    expect(asSet(GHOST_CIRCLE_ATTRIBS)).toEqual(asSet(declaredAttribs(GHOST_CIRCLE_VERTEX_SRC)));
  });

  it('no list repeats a name (a duplicate would waste a location query)', () => {
    for (const names of [
      GHOST_LINE_UNIFORMS,
      GHOST_LINE_ATTRIBS,
      GHOST_CIRCLE_UNIFORMS,
      GHOST_CIRCLE_ATTRIBS,
    ]) {
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('the scraper sees the counts the location cache is sized for', () => {
    expect(GHOST_LINE_UNIFORMS.length).toBe(5);
    expect(GHOST_LINE_ATTRIBS.length).toBe(8);
    expect(GHOST_CIRCLE_UNIFORMS.length).toBe(6);
    expect(GHOST_CIRCLE_ATTRIBS.length).toBe(7);
    expect(declaredAttribs(GHOST_LINE_FRAGMENT_SRC)).toEqual([]);
    expect(declaredAttribs(GHOST_CIRCLE_FRAGMENT_SRC)).toEqual([]);
  });
});

describe('surveyMeasurePathLayer program name lists match the GLSL (#339)', () => {
  it('MEASURE_LINE_UNIFORMS covers every uniform the line program declares', () => {
    // u_color is fragment-only here (the tint is applied at shade time), so the
    // union across both stages is what the linked program exposes.
    const declared = [
      ...declaredUniforms(MEASURE_LINE_VERTEX_SRC),
      ...declaredUniforms(MEASURE_LINE_FRAGMENT_SRC),
    ];
    expect(asSet(MEASURE_LINE_UNIFORMS)).toEqual(asSet(declared));
  });

  it('MEASURE_LINE_ATTRIBS covers every attribute the line vertex shader declares', () => {
    expect(asSet(MEASURE_LINE_ATTRIBS)).toEqual(asSet(declaredAttribs(MEASURE_LINE_VERTEX_SRC)));
  });

  it('MEASURE_CIRCLE_UNIFORMS covers every uniform the circle program declares', () => {
    const declared = [
      ...declaredUniforms(MEASURE_CIRCLE_VERTEX_SRC),
      ...declaredUniforms(MEASURE_CIRCLE_FRAGMENT_SRC),
    ];
    expect(asSet(MEASURE_CIRCLE_UNIFORMS)).toEqual(asSet(declared));
  });

  it('MEASURE_CIRCLE_ATTRIBS covers every attribute the circle vertex shader declares', () => {
    expect(asSet(MEASURE_CIRCLE_ATTRIBS)).toEqual(asSet(declaredAttribs(MEASURE_CIRCLE_VERTEX_SRC)));
  });

  it('no list repeats a name (a duplicate would waste a location query)', () => {
    for (const names of [
      MEASURE_LINE_UNIFORMS,
      MEASURE_LINE_ATTRIBS,
      MEASURE_CIRCLE_UNIFORMS,
      MEASURE_CIRCLE_ATTRIBS,
    ]) {
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('the scraper sees the counts the location cache is sized for', () => {
    expect(MEASURE_LINE_UNIFORMS.length).toBe(5);
    expect(MEASURE_LINE_ATTRIBS.length).toBe(4);
    expect(MEASURE_CIRCLE_UNIFORMS.length).toBe(5);
    expect(MEASURE_CIRCLE_ATTRIBS.length).toBe(2);
    expect(declaredAttribs(MEASURE_LINE_FRAGMENT_SRC)).toEqual([]);
    expect(declaredAttribs(MEASURE_CIRCLE_FRAGMENT_SRC)).toEqual([]);
  });
});
