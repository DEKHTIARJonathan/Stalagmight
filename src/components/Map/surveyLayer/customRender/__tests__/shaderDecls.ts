/**
 * GLSL declaration scraping for the program-name pins (#339). NOT a test suite -
 * a helper the suites in this directory import.
 *
 * The layers pass fixed name lists to linkProgramBundle(); these readers pull
 * the names the shader sources actually declare, so a rename in shaders.ts that
 * is not mirrored in the list fails a test instead of silently resolving to a
 * null uniform location at runtime.
 */

/** `uniform [precision] <type> <name>`, leading whitespace allowed. `\w+` stops
 *  before a `[`, so an array uniform (`u_foo[4]`) already yields the bare name. */
const UNIFORM_RE = /^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(u_\w+)/gm;

/** `in [precision] <type> <name>`, leading whitespace allowed. Fragment shaders
 *  also declare `in` VARYINGS, and only a vertex shader's `in`s are attributes -
 *  the `a_` prefix separates the two here (every varying in shaders.ts is
 *  `v_`-prefixed), but callers should still pass vertex sources only. */
const ATTRIB_RE = /^\s*in\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(a_\w+)/gm;

function scrape(src: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(re)) if (m[1]) out.push(m[1]);
  return out;
}

/** Uniform names declared by a shader source, in declaration order. */
export function declaredUniforms(src: string): string[] {
  return scrape(src, UNIFORM_RE);
}

/** Attribute names declared by a VERTEX shader source, in declaration order. */
export function declaredAttribs(src: string): string[] {
  return scrape(src, ATTRIB_RE);
}

/** Every `uniform` declaration, in ANY form - the anti-blind-spot count. A
 *  declaration the scraper cannot parse (new qualifier, non-`u_` name) makes
 *  this exceed declaredUniforms().length, failing the pin loudly instead of
 *  letting the set-equality tests pass vacuously on both sides missing it. */
export function rawUniformDeclCount(src: string): number {
  return (src.match(/^\s*uniform\b/gm) ?? []).length;
}

/** Every `in` declaration of a VERTEX shader (all of which are attributes). */
export function rawVertexInputCount(src: string): number {
  return (src.match(/^\s*in\b/gm) ?? []).length;
}
