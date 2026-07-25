/**
 * GLSL ES 3.00 shader sources for the dedicated MEASURE-PATH custom layer (#26,
 * stage 2a of #customRender stock deletion). A small sibling of `shaders.ts` /
 * `ghostShaders.ts`: it draws the measured along-cave-line path - the ruler's
 * result - as round-cap tint lines (the measured shots) and filled tint discs
 * (the measured stations), so the tint no longer depends on the stock
 * `survey-measure-path` layer reading the stock `-shots` vector-tile source.
 *
 * Trimmed to exactly what a single-color overlay needs: ONE tint carried as a
 * uniform (`u_color`, premultiplied in the fragment) rather than a per-vertex
 * color attribute, and none of the ghost's per-frame screen-offset / move flags
 * or the bulk layer's reference / dim / highlight / depth-gradient machinery.
 * Positions are anchor-relative mercator (the `mercator.ts` precision trick), so
 * a mid-measurement ZOOM re-projects correctly with no rebuild.
 *
 * The round-cap capsule extrusion + edge-feather math is the same as `shaders.ts`
 * (adapted from MapLibre GL JS line shaders, BSD-3-Clause; see that file), which
 * is why the tint's round caps line up exactly with the stock layer's
 * `line-cap: round`. All px are DEVICE pixels; `u_viewport` is
 * `[drawingBufferWidth, drawingBufferHeight]`.
 */

export const MEASURE_LINE_VERTEX_SRC = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_half_width;
uniform float u_aa;
in vec2 a_pos_a;
in vec2 a_pos_b;
in float a_endpoint;
in float a_side;
out float v_perp;
out float v_along;
out float v_len;
void main() {
  vec4 pa = u_matrix * vec4(a_pos_a, 0.0, 1.0);
  vec4 pb = u_matrix * vec4(a_pos_b, 0.0, 1.0);
  vec2 sa = pa.xy / pa.w;
  vec2 sb = pb.xy / pb.w;
  // Screen-pixel A->B vector, unit direction, and perpendicular normal. Guard a
  // zero-length (coincident-endpoint) segment so normalize() never yields NaN.
  vec2 segPx = (sb - sa) * u_viewport * 0.5;
  float segLen = length(segPx);
  vec2 dir = (segLen > 0.0001) ? (segPx / segLen) : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  vec4 base = (a_endpoint < 0.5) ? pa : pb;
  float outset = u_half_width + u_aa;
  // Round caps: extrude by outset ALONG the segment past each endpoint (A verts
  // backward, B verts forward) plus the perpendicular width offset, so the
  // fragment's capsule SDF has room to round the ends. Vertex count unchanged.
  float capSign = (a_endpoint < 0.5) ? -1.0 : 1.0;
  vec2 offsetPx = normal * a_side * outset + dir * capSign * outset;
  vec2 offsetClip = offsetPx / u_viewport * 2.0 * base.w;
  gl_Position = vec4(base.xy + offsetClip, base.z, base.w);
  v_perp = a_side * outset;
  v_along = ((a_endpoint < 0.5) ? 0.0 : segLen) + capSign * outset;
  v_len = segLen;
}`;

export const MEASURE_LINE_FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform float u_half_width;
uniform float u_aa;
uniform vec4 u_color;
in float v_perp;
in float v_along;
in float v_len;
out vec4 fragColor;
void main() {
  float outset = u_half_width + u_aa;
  // Capsule SDF: distance to the segment [0, v_len]; past an endpoint it is the
  // radial distance to that endpoint, rounding the cap with the same feather.
  float alongClamp = clamp(v_along, 0.0, v_len);
  float dist = length(vec2(v_along - alongClamp, v_perp));
  float alpha = clamp(min(dist + u_aa, outset - dist) / u_aa, 0.0, 1.0);
  float a = u_color.a * alpha;
  fragColor = vec4(u_color.rgb * a, a);
}`;

export const MEASURE_CIRCLE_VERTEX_SRC = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_radius;
uniform float u_aa;
in vec2 a_center;
in vec2 a_corner;
out vec2 v_offset;
void main() {
  vec4 c = u_matrix * vec4(a_center, 0.0, 1.0);
  float ext = u_radius + u_aa;
  vec2 offsetPx = a_corner * ext;
  vec2 offsetClip = offsetPx / u_viewport * 2.0 * c.w;
  gl_Position = vec4(c.xy + offsetClip, c.z, c.w);
  v_offset = offsetPx;
}`;

export const MEASURE_CIRCLE_FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform float u_radius;
uniform float u_aa;
uniform vec4 u_color;
in vec2 v_offset;
out vec4 fragColor;
void main() {
  float d = length(v_offset);
  // Filled disc with the same last-u_aa-px edge feather the bulk stations use.
  float alpha = clamp((u_radius - d) / u_aa + 0.5, 0.0, 1.0);
  float a = u_color.a * alpha;
  fragColor = vec4(u_color.rgb * a, a);
}`;
