/**
 * GLSL ES 3.00 shader sources for the drag-GHOST custom layer (#mem drag
 * latency). Siblings of `shaders.ts`, trimmed to what a transient move preview
 * needs and with ONE thing the bulk shaders lack: a per-frame SCREEN-PIXEL
 * offset uniform (`u_offset_px`) applied in the vertex shader.
 *
 * Why the offset lives in the shader: the moving geometry's vertices are the
 * ORIGINAL (pre-move) positions captured ONCE at drag start, stored
 * anchor-relative mercator (same precision trick as `mercator.ts`) and projected
 * through `u_matrix` every frame. The live drag delta — a screen-pixel residual
 * recomputed each frame by MapCanvas against the re-projected grab point — is
 * added to the projected endpoints as a screen-space shift. Because the anchor
 * re-projects correctly through `u_matrix`, a mid-drag ZOOM keeps the ghost glued
 * to the cursor with zero rebuild: the vertices follow the camera and the
 * screen-px offset stays the exact cursor delta. This replaces the stock ghost's
 * async `setData` re-bake + `line-translate` state machine (which overshot,
 * because a landed bake is drawn progressively per tile and the land signal is
 * unobservable) with a single uniform write + `triggerRepaint`.
 *
 * PER-ENDPOINT MOVE FLAGS: a shot whose only ONE station is dragged stretches
 * around its fixed end. `a_move_a` / `a_move_b` (0/1) gate the offset per
 * endpoint, so the capsule direction/length recompute from the OFFSET endpoints
 * and the shot stretches exactly like `buildDragPreviewFeatureCollection` did.
 *
 * The round-cap capsule extrusion + edge-feather math is the same as `shaders.ts`
 * (adapted from MapLibre GL JS line shaders, BSD-3-Clause); see that file. Ghost
 * geometry carries a single flat color per vertex (alpha pre-baked to the
 * preview's 0.85 line/fill opacity) and a per-vertex width multiplier so shots
 * and the wider closure lines share one draw. All px are DEVICE pixels;
 * `u_viewport` is `[drawingBufferWidth, drawingBufferHeight]` and `u_offset_px`
 * is the CSS drag delta pre-multiplied by devicePixelRatio (screen +y is DOWN).
 */

export const GHOST_LINE_VERTEX_SRC = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_half_width;
uniform float u_aa;
uniform vec2 u_offset_px;
in vec2 a_pos_a;
in vec2 a_pos_b;
in float a_endpoint;
in float a_side;
in float a_move_a;
in float a_move_b;
in vec4 a_color;
in float a_width_mul;
out vec4 v_color;
out float v_perp;
out float v_along;
out float v_len;
out float v_width_mul;
void main() {
  vec4 pa = u_matrix * vec4(a_pos_a, 0.0, 1.0);
  vec4 pb = u_matrix * vec4(a_pos_b, 0.0, 1.0);
  // Anchored endpoints in NDC, each shifted by the SCREEN-px drag residual when
  // that endpoint is a moving one. Screen +y is DOWN, NDC +y is UP, so flip y.
  vec2 sa = pa.xy / pa.w + vec2(1.0, -1.0) * (a_move_a * u_offset_px) / u_viewport * 2.0;
  vec2 sb = pb.xy / pb.w + vec2(1.0, -1.0) * (a_move_b * u_offset_px) / u_viewport * 2.0;
  vec4 baseA = vec4(sa * pa.w, pa.z, pa.w);
  vec4 baseB = vec4(sb * pb.w, pb.z, pb.w);
  // Screen-pixel A->B vector from the OFFSET endpoints (so a one-end drag
  // stretches the capsule), unit direction, and perpendicular normal.
  vec2 segPx = (sb - sa) * u_viewport * 0.5;
  float segLen = length(segPx);
  vec2 dir = (segLen > 0.0001) ? (segPx / segLen) : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  vec4 base = (a_endpoint < 0.5) ? baseA : baseB;
  float outset = u_half_width * a_width_mul + u_aa;
  // Round caps: extrude by outset ALONG the segment past each endpoint plus the
  // perpendicular width offset (see shaders.ts); vertex count unchanged.
  float capSign = (a_endpoint < 0.5) ? -1.0 : 1.0;
  vec2 offsetPx = normal * a_side * outset + dir * capSign * outset;
  vec2 offsetClip = offsetPx / u_viewport * 2.0 * base.w;
  gl_Position = vec4(base.xy + offsetClip, base.z, base.w);
  v_color = a_color;
  v_perp = a_side * outset;
  v_along = ((a_endpoint < 0.5) ? 0.0 : segLen) + capSign * outset;
  v_len = segLen;
  v_width_mul = a_width_mul;
}`;

export const GHOST_LINE_FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform float u_half_width;
uniform float u_aa;
in vec4 v_color;
in float v_perp;
in float v_along;
in float v_len;
in float v_width_mul;
out vec4 fragColor;
void main() {
  float outset = u_half_width * v_width_mul + u_aa;
  // Capsule SDF: distance to the segment [0, v_len], rounding both caps.
  float alongClamp = clamp(v_along, 0.0, v_len);
  float dist = length(vec2(v_along - alongClamp, v_perp));
  float alpha = clamp(min(dist + u_aa, outset - dist) / u_aa, 0.0, 1.0);
  float a = v_color.a * alpha;
  fragColor = vec4(v_color.rgb * a, a);
}`;

export const GHOST_CIRCLE_VERTEX_SRC = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_radius;
uniform float u_stroke_width;
uniform float u_aa;
uniform vec2 u_offset_px;
in vec2 a_center;
in vec2 a_corner;
in float a_move;
in vec4 a_fill;
in vec4 a_stroke;
in float a_size_mul;
in float a_stroke_mul;
out vec4 v_fill;
out vec4 v_stroke;
out vec2 v_offset;
out float v_size_mul;
out float v_stroke_mul;
void main() {
  vec4 c = u_matrix * vec4(a_center, 0.0, 1.0);
  vec2 sc = c.xy / c.w + vec2(1.0, -1.0) * (a_move * u_offset_px) / u_viewport * 2.0;
  vec4 base = vec4(sc * c.w, c.z, c.w);
  // Per-vertex radius / stroke multipliers let the on-top highlight pass draw a
  // larger disc + ring (hover/selection) than the base moving stations, which
  // stay at size 1 (the ghost's selection styling).
  float ext = (u_radius * a_size_mul + u_stroke_width * a_stroke_mul) + u_aa;
  vec2 offsetPx = a_corner * ext;
  vec2 offsetClip = offsetPx / u_viewport * 2.0 * base.w;
  gl_Position = vec4(base.xy + offsetClip, base.z, base.w);
  v_fill = a_fill;
  v_stroke = a_stroke;
  v_offset = offsetPx;
  v_size_mul = a_size_mul;
  v_stroke_mul = a_stroke_mul;
}`;

export const GHOST_CIRCLE_FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform float u_radius;
uniform float u_stroke_width;
uniform float u_aa;
in vec4 v_fill;
in vec4 v_stroke;
in vec2 v_offset;
in float v_size_mul;
in float v_stroke_mul;
out vec4 fragColor;
void main() {
  float rad = u_radius * v_size_mul;
  float sw = u_stroke_width * v_stroke_mul;
  float d = length(v_offset);
  float outer = rad + sw;
  float outerAlpha = clamp((outer - d) / u_aa + 0.5, 0.0, 1.0);
  float fillT = clamp((rad - d) / u_aa + 0.5, 0.0, 1.0);
  vec4 col = mix(v_stroke, v_fill, fillT);
  float a = col.a * outerAlpha;
  fragColor = vec4(col.rgb * a, a);
}`;
