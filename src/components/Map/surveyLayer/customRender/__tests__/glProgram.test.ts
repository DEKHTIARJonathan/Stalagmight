import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  linkProgramBundle,
  deleteProgramBundle,
  bindVec2,
  bindFloat,
  bindColor,
} from '../glProgram';
import { FakeGl, FakeWebGLBuffer, asGl } from './fakeGl';

const UNIFORMS = ['u_matrix', 'u_aa'] as const;
const ATTRIBS = ['a_pos', 'a_color'] as const;

describe('linkProgramBundle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('queries each uniform and each attribute exactly once, keyed by name', () => {
    const gl = new FakeGl();
    const bundle = linkProgramBundle(asGl(gl), 'vs', 'fs', UNIFORMS, ATTRIBS, '[tag]');
    expect(bundle).not.toBeNull();
    expect(gl.uniformQueries).toEqual(['u_matrix', 'u_aa']);
    expect(gl.attribQueries).toEqual(['a_pos', 'a_color']);
    expect(gl.count('getUniformLocation')).toBe(2);
    expect(gl.count('getAttribLocation')).toBe(2);
    // Each key holds the location the context handed out for THAT name.
    expect(bundle?.uniforms.u_matrix).toBe(gl.uniformLocation('u_matrix'));
    expect(bundle?.uniforms.u_aa).toBe(gl.uniformLocation('u_aa'));
    expect(bundle?.uniforms.u_matrix).not.toBe(bundle?.uniforms.u_aa);
    expect(bundle?.attribs.a_pos).toBe(gl.attribLocation('a_pos'));
    expect(bundle?.attribs.a_color).toBe(gl.attribLocation('a_color'));
    expect(bundle?.attribs.a_pos).not.toBe(bundle?.attribs.a_color);
  });

  it('returns null and deletes the program when the link fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gl = new FakeGl();
    gl.linkOk = false;
    expect(linkProgramBundle(asGl(gl), 'vs', 'fs', UNIFORMS, ATTRIBS, '[tag]')).toBeNull();
    expect(gl.count('deleteProgram')).toBe(1);
    // No locations are resolved for a program that never linked.
    expect(gl.count('getUniformLocation')).toBe(0);
    expect(gl.count('getAttribLocation')).toBe(0);
    expect(warn.mock.calls[0]?.[0]).toBe('[tag] program link failed:');
    expect(warn.mock.calls[0]?.[1]).toBe('fake program log');
  });

  it('returns null on a compile failure, before any program exists', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gl = new FakeGl();
    gl.compileOk = false;
    expect(linkProgramBundle(asGl(gl), 'vs', 'fs', UNIFORMS, ATTRIBS, '[tag]')).toBeNull();
    expect(gl.count('createProgram')).toBe(0);
    expect(gl.count('deleteProgram')).toBe(0);
    expect(warn.mock.calls[0]?.[0]).toBe('[tag] shader compile failed:');
    expect(warn.mock.calls[0]?.[1]).toBe('fake shader log');
  });
});

describe('deleteProgramBundle', () => {
  it('deletes the bundle program, and is a no-op on null', () => {
    const gl = new FakeGl();
    const bundle = linkProgramBundle(asGl(gl), 'vs', 'fs', UNIFORMS, ATTRIBS, '[tag]');
    deleteProgramBundle(asGl(gl), null);
    expect(gl.count('deleteProgram')).toBe(0);
    deleteProgramBundle(asGl(gl), bundle);
    expect(gl.count('deleteProgram')).toBe(1);
  });
});

describe('attribute binders', () => {
  const binders = [
    { name: 'bindVec2', bind: bindVec2, size: 2, type: 'FLOAT', normalized: false },
    { name: 'bindFloat', bind: bindFloat, size: 1, type: 'FLOAT', normalized: false },
    { name: 'bindColor', bind: bindColor, size: 4, type: 'UNSIGNED_BYTE', normalized: true },
  ] as const;

  it('binds with the exact (size, type, normalized) triple per variant', () => {
    for (const b of binders) {
      const gl = new FakeGl();
      const buf = new FakeWebGLBuffer() as unknown as WebGLBuffer;
      b.bind(asGl(gl), 3, buf);
      expect(gl.count('bindBuffer')).toBe(1);
      expect(gl.bufferBinds[0]).toEqual({ target: gl.ARRAY_BUFFER, buffer: buf });
      expect(gl.count('enableVertexAttribArray')).toBe(1);
      expect(gl.attribPointers).toEqual([
        { loc: 3, size: b.size, type: gl[b.type], normalized: b.normalized },
      ]);
    }
  });

  it('is a complete no-op for a dropped attribute (loc < 0)', () => {
    for (const b of binders) {
      const gl = new FakeGl();
      b.bind(asGl(gl), -1, new FakeWebGLBuffer() as unknown as WebGLBuffer);
      expect(gl.calls).toEqual({});
    }
  });
});
