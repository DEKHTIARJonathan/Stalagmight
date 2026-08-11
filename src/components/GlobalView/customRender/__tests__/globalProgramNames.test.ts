import { describe, expect, it } from 'vitest';
import {
  GLOBAL_LINE_UNIFORMS,
  GLOBAL_LINE_ATTRIBS,
  GLOBAL_CIRCLE_UNIFORMS,
  GLOBAL_CIRCLE_ATTRIBS,
} from '../globalCustomLayer';
import {
  GLOBAL_LINE_VERTEX_SRC,
  GLOBAL_LINE_FRAGMENT_SRC,
  GLOBAL_CIRCLE_VERTEX_SRC,
  GLOBAL_CIRCLE_FRAGMENT_SRC,
} from '../globalShaders';
import {
  declaredUniforms,
  declaredAttribs,
} from '../../../Map/surveyLayer/customRender/__tests__/shaderDecls';

/** Set comparison as a sorted array, so a mismatch prints the missing name. */
const asSet = (names: readonly string[]): string[] => [...new Set(names)].sort();

describe('globalCustomLayer program name lists match the GLSL (#339)', () => {
  it('GLOBAL_LINE_UNIFORMS covers every uniform the line program declares', () => {
    // Union: the fragment shader re-declares u_aa, and a uniform declared in
    // either stage is one location on the linked program.
    const declared = [
      ...declaredUniforms(GLOBAL_LINE_VERTEX_SRC),
      ...declaredUniforms(GLOBAL_LINE_FRAGMENT_SRC),
    ];
    expect(asSet(GLOBAL_LINE_UNIFORMS)).toEqual(asSet(declared));
  });

  it('GLOBAL_LINE_ATTRIBS covers every attribute the line vertex shader declares', () => {
    expect(asSet(GLOBAL_LINE_ATTRIBS)).toEqual(asSet(declaredAttribs(GLOBAL_LINE_VERTEX_SRC)));
  });

  it('GLOBAL_CIRCLE_UNIFORMS covers every uniform the circle program declares', () => {
    const declared = [
      ...declaredUniforms(GLOBAL_CIRCLE_VERTEX_SRC),
      ...declaredUniforms(GLOBAL_CIRCLE_FRAGMENT_SRC),
    ];
    expect(asSet(GLOBAL_CIRCLE_UNIFORMS)).toEqual(asSet(declared));
  });

  it('GLOBAL_CIRCLE_ATTRIBS covers every attribute the circle vertex shader declares', () => {
    expect(asSet(GLOBAL_CIRCLE_ATTRIBS)).toEqual(asSet(declaredAttribs(GLOBAL_CIRCLE_VERTEX_SRC)));
  });

  it('no list repeats a name (a duplicate would waste a location query)', () => {
    for (const names of [
      GLOBAL_LINE_UNIFORMS,
      GLOBAL_LINE_ATTRIBS,
      GLOBAL_CIRCLE_UNIFORMS,
      GLOBAL_CIRCLE_ATTRIBS,
    ]) {
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('the scraper sees the counts the location cache is sized for', () => {
    // Guards the regexes themselves: an over-permissive pattern that matched
    // nothing (or matched varyings) would make the set-equality tests vacuous.
    expect(GLOBAL_LINE_UNIFORMS.length).toBe(6);
    expect(GLOBAL_LINE_ATTRIBS.length).toBe(9);
    expect(GLOBAL_CIRCLE_UNIFORMS.length).toBe(8);
    expect(GLOBAL_CIRCLE_ATTRIBS.length).toBe(7);
    expect(declaredAttribs(GLOBAL_LINE_FRAGMENT_SRC)).toEqual([]);
    expect(declaredAttribs(GLOBAL_CIRCLE_FRAGMENT_SRC)).toEqual([]);
  });
});
