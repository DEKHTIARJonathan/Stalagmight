/**
 * GLSL ES 3.00 shader sources for the global view's custom WebGL survey layer
 * (#customRender). Sibling of `Map/surveyLayer/customRender/shaders.ts`: same
 * screen-space AA line extrusion + fragment feather (adapted from MapLibre GL
 * JS `line.{vertex,fragment}.glsl`, BSD-3-Clause) and the same anchor-relative
 * mercator -> clip projection via `defaultProjectionData.mainMatrix`.
 *
 * What differs from the single-system layer: the global view draws every
 * system at once, each in its own hash-derived color, and bakes the stock
 * global layers' per-system HOVER / SELECT / reference / search-dim emphasis
 * natively:
 *  - `a_system` (per-vertex system index) + `u_hover_system` (the hovered
 *    system index, or -1): a cursor-follow uniform, so hover restyle is a plain
 *    uniform update with no buffer re-upload.
 *  - `a_selected` (per-vertex flag): re-uploaded only on a selection change.
 *  - `a_dim` (per-vertex search-dim flag): 0.25 opacity, re-uploaded on search.
 *  - `a_reference` (per-vertex): the ShotKind discriminant, 0 Normal / 1 Jump /
 *    2 Reference (#27). Virtual legs draw thinner (0.5x width); a Jump dims to
 *    0.5 alpha and a Reference to 0.28, matching the single-system renderer.
 *    Both collapse when reference shots are hidden.
 * Width/radius emphasis mirrors the stock paint cases exactly (hover > select >
 * reference > default). Premultiplied-alpha output matches MapLibre's blend.
 */

import {
  SHOT_ALPHA_JUMP,
  SHOT_ALPHA_REFERENCE,
  glslFloat,
} from '../../Map/surveyLayer/customRender/shaders';

/** All px sizes are DEVICE pixels; `u_viewport` is the drawing-buffer size.
 *  `u_matrix` maps anchor-relative mercator -> clip (composed from MapLibre's
 *  `defaultProjectionData.mainMatrix`). Per-vertex width emphasis makes the AA
 *  outset vary per segment, so it is passed to the fragment as `v_outset`. */
export const GLOBAL_LINE_VERTEX_SRC = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_half_width;
uniform float u_aa;
uniform float u_hide_reference;
uniform float u_hover_system;
in vec2 a_pos_a;
in vec2 a_pos_b;
in float a_endpoint;
in float a_side;
in vec4 a_color;
in float a_reference;
in float a_dim;
in float a_system;
in float a_selected;
out vec4 v_color;
out float v_edge;
out float v_outset;
void main() {
  // Discriminant, not a bool (#27): 0 Normal / 1 Jump / 2 Reference.
  bool isJump = a_reference > 0.5 && a_reference < 1.5;
  bool isRef = a_reference > 1.5;
  bool isVirtual = isJump || isRef;
  // Reference shots hidden (setShowReferenceShots(false)): collapse the quad.
  // Global View has one toggle covering both virtual kinds, so this stays
  // all-or-nothing here - unlike the single-system layer's split toggles.
  if (isVirtual && u_hide_reference > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_color = vec4(0.0);
    v_edge = 0.0;
    v_outset = 0.0;
    return;
  }
  bool isHover = abs(a_system - u_hover_system) < 0.5;
  bool isSel = a_selected > 0.5;
  // Width emphasis mirrors the stock line-width case order (hover 4 / select 3
  // / reference 1 / else 2, base 2) as a multiplier over u_half_width.
  float widthMul = isHover ? 2.0 : (isSel ? 1.5 : (isVirtual ? 0.5 : 1.0));
  float halfWidth = u_half_width * widthMul;
  vec4 pa = u_matrix * vec4(a_pos_a, 0.0, 1.0);
  vec4 pb = u_matrix * vec4(a_pos_b, 0.0, 1.0);
  vec2 sa = pa.xy / pa.w;
  vec2 sb = pb.xy / pb.w;
  vec2 dir = normalize((sb - sa) * u_viewport);
  vec2 normal = vec2(-dir.y, dir.x);
  vec4 base = (a_endpoint < 0.5) ? pa : pb;
  float outset = halfWidth + u_aa;
  vec2 offsetPx = normal * a_side * outset;
  vec2 offsetClip = offsetPx / u_viewport * 2.0 * base.w;
  gl_Position = vec4(base.xy + offsetClip, base.z, base.w);
  // Search-dim wins over the reference 0.5 case (stock: non-matching 0.25).
  v_color = a_color;
  if (a_dim > 0.5) v_color.a *= 0.25;
  else if (isRef) v_color.a *= ${glslFloat(SHOT_ALPHA_REFERENCE)};
  else if (isJump) v_color.a *= ${glslFloat(SHOT_ALPHA_JUMP)};
  v_edge = a_side;
  v_outset = outset;
}`;

export const GLOBAL_LINE_FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform float u_aa;
in vec4 v_color;
in float v_edge;
in float v_outset;
out vec4 fragColor;
void main() {
  float dist = abs(v_edge) * v_outset;
  float alpha = clamp(min(dist + u_aa, v_outset - dist) / u_aa, 0.0, 1.0);
  float a = v_color.a * alpha;
  fragColor = vec4(v_color.rgb * a, a);
}`;

export const GLOBAL_CIRCLE_VERTEX_SRC = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_radius;
uniform float u_stroke_width;
uniform float u_aa;
uniform float u_hide_reference;
uniform float u_hover_system;
uniform vec4 u_stroke_color;
in vec2 a_center;
in vec2 a_corner;
in vec4 a_fill;
in float a_all_reference;
in float a_dim;
in float a_system;
in float a_selected;
out vec4 v_fill;
out vec4 v_stroke;
out vec2 v_offset;
out float v_rad;
out float v_sw;
out float v_dim;
void main() {
  // All-reference stations hidden with reference shots: collapse the quad.
  if (a_all_reference > 0.5 && u_hide_reference > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_fill = vec4(0.0);
    v_stroke = vec4(0.0);
    v_offset = vec2(0.0);
    v_rad = 0.0;
    v_sw = 0.0;
    v_dim = 0.0;
    return;
  }
  bool isHover = abs(a_system - u_hover_system) < 0.5;
  bool isSel = a_selected > 0.5;
  // Radius emphasis: stock circle-radius 6 / 5 / 4 (base 4) -> 1.5 / 1.25 / 1.
  float radMul = isHover ? 1.5 : (isSel ? 1.25 : 1.0);
  // Stroke emphasis: stock circle-stroke-width 2 for hover/select, else 1.
  float strokeMul = (isHover || isSel) ? 2.0 : 1.0;
  float rad = u_radius * radMul;
  float sw = u_stroke_width * strokeMul;
  float ext = rad + sw + u_aa;
  vec4 c = u_matrix * vec4(a_center, 0.0, 1.0);
  vec2 offsetPx = a_corner * ext;
  vec2 offsetClip = offsetPx / u_viewport * 2.0 * c.w;
  gl_Position = vec4(c.xy + offsetClip, c.z, c.w);
  v_fill = a_fill;
  v_stroke = u_stroke_color;
  v_offset = offsetPx;
  v_rad = rad;
  v_sw = sw;
  v_dim = a_dim;
}`;

export const GLOBAL_CIRCLE_FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform float u_aa;
in vec4 v_fill;
in vec4 v_stroke;
in vec2 v_offset;
in float v_rad;
in float v_sw;
in float v_dim;
out vec4 fragColor;
void main() {
  float d = length(v_offset);
  float outer = v_rad + v_sw;
  float outerAlpha = clamp((outer - d) / u_aa + 0.5, 0.0, 1.0);
  float fillT = clamp((v_rad - d) / u_aa + 0.5, 0.0, 1.0);
  vec4 col = mix(v_stroke, v_fill, fillT);
  // Search-dim (non-matching systems) draws at 0.25 (fill + stroke together).
  float dimF = (v_dim > 0.5) ? 0.25 : 1.0;
  float a = col.a * outerAlpha * dimF;
  fragColor = vec4(col.rgb * a, a);
}`;
