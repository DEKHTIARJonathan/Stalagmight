/**
 * GLSL ES 3.00 shader sources for the custom-render prototype (#customRender).
 *
 * Targets WebGL2 (MapLibre 5.16 runs a WebGL2 context) with premultiplied-alpha
 * output to match MapLibre's `gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)`.
 *
 * The line vertex extrusion + fragment edge-feather (AA) math is adapted from
 * MapLibre GL JS `src/shaders/line.vertex.glsl` and `line.fragment.glsl`
 * (BSD-3-Clause, derived from Mapbox GL JS pre-fork). What was reused: the
 * screen-space normal extrusion by an `outset = halfwidth + antialiasing`, and
 * the fragment `alpha = clamp(min(dist + blur, outset - dist) / blur, 0, 1)`
 * feather. What differs: MapLibre extrudes in tile space using its packed
 * `a_pos_normal` / `a_data` encoding and `projectTile()`; here each vertex
 * carries both segment endpoints (anchor-relative mercator) and the normal is
 * computed from the projected screen-space direction, so butt-cap quads work
 * with a raw projection matrix. The perspective `v_gamma_scale` term is dropped
 * (prototype assumes near-nadir viewing); note this if AA looks soft under pitch.
 */

/** All px sizes are DEVICE pixels; `u_viewport` is `[drawingBufferWidth,
 *  drawingBufferHeight]`. `u_matrix` maps anchor-relative mercator -> clip; it
 *  is composed from MapLibre's `defaultProjectionData.mainMatrix` (the mercator
 *  [0,1] -> clip matrix), NOT `modelViewProjectionMatrix` (world-pixel space). */
export const LINE_VERTEX_SRC = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_half_width;
uniform float u_aa;
uniform float u_hide_reference;
in vec2 a_pos_a;
in vec2 a_pos_b;
in float a_endpoint;
in float a_side;
in vec4 a_color;
in float a_reference;
out vec4 v_color;
out float v_edge;
void main() {
  // Reference shots hidden (setShowReferenceShots(false)): collapse the whole
  // quad to a single clipped point so it produces no fragments. All 4 vertices
  // of a segment share a_reference, so both triangles degenerate together.
  if (a_reference > 0.5 && u_hide_reference > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_color = vec4(0.0);
    v_edge = 0.0;
    return;
  }
  vec4 pa = u_matrix * vec4(a_pos_a, 0.0, 1.0);
  vec4 pb = u_matrix * vec4(a_pos_b, 0.0, 1.0);
  vec2 sa = pa.xy / pa.w;
  vec2 sb = pb.xy / pb.w;
  vec2 dir = normalize((sb - sa) * u_viewport);
  vec2 normal = vec2(-dir.y, dir.x);
  vec4 base = (a_endpoint < 0.5) ? pa : pb;
  float outset = u_half_width + u_aa;
  vec2 offsetPx = normal * a_side * outset;
  vec2 offsetClip = offsetPx / u_viewport * 2.0 * base.w;
  gl_Position = vec4(base.xy + offsetClip, base.z, base.w);
  // Reference shots draw at 0.5 opacity (mirrors the stock shots/gradient
  // layers' isReference line-opacity case).
  v_color = a_color;
  if (a_reference > 0.5) v_color.a *= 0.5;
  v_edge = a_side;
}`;

export const LINE_FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform float u_half_width;
uniform float u_aa;
in vec4 v_color;
in float v_edge;
out vec4 fragColor;
void main() {
  float outset = u_half_width + u_aa;
  float dist = abs(v_edge) * outset;
  // MapLibre line AA: feather the last u_aa px of the outset.
  float alpha = clamp(min(dist + u_aa, outset - dist) / u_aa, 0.0, 1.0);
  float a = v_color.a * alpha;
  fragColor = vec4(v_color.rgb * a, a);
}`;

export const CIRCLE_VERTEX_SRC = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_radius;
uniform float u_stroke_width;
uniform float u_aa;
uniform float u_hide_reference;
in vec2 a_center;
in vec2 a_corner;
in vec4 a_fill;
in vec4 a_stroke;
in float a_all_reference;
out vec4 v_fill;
out vec4 v_stroke;
out vec2 v_offset;
void main() {
  // All-reference stations hidden with reference shots (matches the stock
  // stations layer's not-allShotsReference filter): collapse the quad to a
  // single clipped point.
  if (a_all_reference > 0.5 && u_hide_reference > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_fill = vec4(0.0);
    v_stroke = vec4(0.0);
    v_offset = vec2(0.0);
    return;
  }
  vec4 c = u_matrix * vec4(a_center, 0.0, 1.0);
  float ext = u_radius + u_stroke_width + u_aa;
  vec2 offsetPx = a_corner * ext;
  vec2 offsetClip = offsetPx / u_viewport * 2.0 * c.w;
  gl_Position = vec4(c.xy + offsetClip, c.z, c.w);
  v_fill = a_fill;
  v_stroke = a_stroke;
  v_offset = offsetPx;
}`;

export const CIRCLE_FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform float u_radius;
uniform float u_stroke_width;
uniform float u_aa;
in vec4 v_fill;
in vec4 v_stroke;
in vec2 v_offset;
out vec4 fragColor;
void main() {
  float d = length(v_offset);
  float outer = u_radius + u_stroke_width;
  float outerAlpha = clamp((outer - d) / u_aa + 0.5, 0.0, 1.0);
  float fillT = clamp((u_radius - d) / u_aa + 0.5, 0.0, 1.0);
  vec4 col = mix(v_stroke, v_fill, fillT);
  float a = col.a * outerAlpha;
  fragColor = vec4(col.rgb * a, a);
}`;
