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
in float a_dim;
in float a_hide;
out vec4 v_color;
out float v_edge;
void main() {
  // Drag-hidden shots (a moving feature excluded during a move drag): collapse
  // the whole quad to a single clipped point. All 4 verts of a segment share
  // a_hide, so both triangles degenerate together. Mirrors the stock bulk
  // layers' setFilter exclusion without omitting the shot from the buffers.
  if (a_hide > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_color = vec4(0.0);
    v_edge = 0.0;
    return;
  }
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
  // Dimmed shots (anchored / immovable during move tools) draw at 0.25 and this
  // WINS over the reference 0.5 case, matching the stock line-opacity case order
  // (immovable 0.25, anchored 0.25, isReference 0.5, else 1).
  v_color = a_color;
  if (a_dim > 0.5) v_color.a *= 0.25;
  else if (a_reference > 0.5) v_color.a *= 0.5;
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
in float a_size_mul;
in float a_dim;
in float a_hide;
out vec4 v_fill;
out vec4 v_stroke;
out vec2 v_offset;
out float v_size_mul;
out float v_dim;
void main() {
  // Drag-hidden stations (moving during a move drag): collapse the quad to a
  // single clipped point, without omitting the station from the buffers.
  if (a_hide > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_fill = vec4(0.0);
    v_stroke = vec4(0.0);
    v_offset = vec2(0.0);
    v_size_mul = 1.0;
    v_dim = 0.0;
    return;
  }
  // All-reference stations hidden with reference shots (matches the stock
  // stations layer's not-allShotsReference filter): collapse the quad to a
  // single clipped point.
  if (a_all_reference > 0.5 && u_hide_reference > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_fill = vec4(0.0);
    v_stroke = vec4(0.0);
    v_offset = vec2(0.0);
    v_size_mul = 1.0;
    v_dim = 0.0;
    return;
  }
  vec4 c = u_matrix * vec4(a_center, 0.0, 1.0);
  // Zero-datum stations render 2x (a_size_mul), so the quad extent must grow to
  // fit; the fragment recomputes disc/stroke radii with the same multiplier.
  float ext = (u_radius + u_stroke_width) * a_size_mul + u_aa;
  vec2 offsetPx = a_corner * ext;
  vec2 offsetClip = offsetPx / u_viewport * 2.0 * c.w;
  gl_Position = vec4(c.xy + offsetClip, c.z, c.w);
  v_fill = a_fill;
  v_stroke = a_stroke;
  v_offset = offsetPx;
  v_size_mul = a_size_mul;
  v_dim = a_dim;
}`;

export const CIRCLE_FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform float u_radius;
uniform float u_stroke_width;
uniform float u_aa;
in vec4 v_fill;
in vec4 v_stroke;
in vec2 v_offset;
in float v_size_mul;
in float v_dim;
out vec4 fragColor;
void main() {
  float rad = u_radius * v_size_mul;
  float sw = u_stroke_width * v_size_mul;
  float d = length(v_offset);
  float outer = rad + sw;
  float outerAlpha = clamp((outer - d) / u_aa + 0.5, 0.0, 1.0);
  float fillT = clamp((rad - d) / u_aa + 0.5, 0.0, 1.0);
  vec4 col = mix(v_stroke, v_fill, fillT);
  // Dimmed stations (anchored / immovable) draw at 0.25 (stock circle-opacity +
  // circle-stroke-opacity anchored case); applies uniformly to fill + stroke.
  float dimF = (v_dim > 0.5) ? 0.25 : 1.0;
  float a = col.a * outerAlpha * dimF;
  fragColor = vec4(col.rgb * a, a);
}`;
