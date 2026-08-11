import { describe, expect, it } from 'vitest';
import {
  LINE_UNIFORMS,
  LINE_ATTRIBS,
  CIRCLE_UNIFORMS,
  CIRCLE_ATTRIBS,
} from '../surveyCustomLayer';
import { LABEL_UNIFORMS, LABEL_ATTRIBS } from '../surveyCustomLabelLayer';
import {
  LINE_VERTEX_SRC,
  LINE_FRAGMENT_SRC,
  CIRCLE_VERTEX_SRC,
  CIRCLE_FRAGMENT_SRC,
} from '../shaders';
import { LABEL_VERTEX_SRC, LABEL_FRAGMENT_SRC } from '../labelShaders';
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
