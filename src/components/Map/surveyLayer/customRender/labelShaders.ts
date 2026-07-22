/**
 * GLSL ES 3.00 shader sources + shared attribute/uniform/flag contract for the
 * custom-render LABEL pass (#customRender labels, Phase 0).
 *
 * Sibling of `shaders.ts` (lines + circles); same target (WebGL2 / GLSL ES 3.00,
 * premultiplied-alpha output for MapLibre's `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`)
 * and the same anchor-relative-mercator + screen-px-offset primitive: one anchor
 * per label is projected by `u_matrix` (composed via `composeAnchorMatrix` from
 * `defaultProjectionData.mainMatrix`), then each glyph corner is displaced by a
 * per-vertex screen-space offset — exactly the `CIRCLE_VERTEX_SRC`
 * `offsetPx / u_viewport * 2.0 * base.w` idiom — so a whole word tracks the map
 * during pan for free (matrix reprojection), only the glyph quad varying.
 *
 * WHAT IS NEW vs the geometry shaders:
 *  - The FIRST texture sampler in this renderer: an R8 SDF glyph atlas
 *    (`glyphAtlas.ts`). `a_uv` carries ATLAS PIXEL coords (not normalized) so a
 *    grow (atlas height doubling) needs only the `u_atlas_size` uniform updated,
 *    never a per-glyph re-layout; the vertex shader normalizes.
 *  - Integer attributes `a_kind` / `a_flags` (bound with `vertexAttribIPointer`,
 *    UNSIGNED_BYTE) so the fragment can index per-kind uniform arrays and the
 *    vertex can test flag bits — the design's `(a_flags & HIDE) != 0` sketch.
 *  - Per-kind uniform arrays (size 5, one slot per {@link LABEL_KIND}) so zoom
 *    size / opacity / decimation band / visibility / halo are CPU-recomputed each
 *    frame WITHOUT any buffer rebuild (§3 of the design: the load-bearing "no
 *    rebuild for zoom / toggle / theme / decimation" property).
 *
 * SDF ENCODING (must agree with `glyphAtlas.ts`): TinySDF with `cutoff = 0.25`
 * puts the glyph EDGE at byte `255 * (1 - cutoff) = 191`, i.e. normalized
 * `d = 0.75` — NOT `0.5`. This is exactly MapLibre's own glyph shader constant
 * (`buff = 192/256 = 0.75`); the companion design doc's "0.5 = edge" is a
 * transcription slip for the stated `cutoff: 0.25`, corrected to {@link SDF_EDGE}
 * here so the fragment math matches the bytes the atlas actually produces.
 * Distances grow toward the glyph interior (higher `d` = deeper inside); halos
 * extend OUTWARD (lower `d`), which is why `cutoff 0.25` (6 px outside vs 2 px
 * inside headroom at `radius 8`) is the right asymmetry for outward halos.
 */

/** Per-label KIND, indexing every per-kind uniform array. Mirrors the 5 stock
 *  symbol layers. The numeric values are the shader's `a_kind` contract — keep
 *  in lock-step with the `int(a_kind)` switch below and the uniform-array order. */
export const LABEL_KIND = {
  SHOT_LABEL: 0,
  STATION_LABEL: 1,
  SECTION_NAME: 2,
  STATION_COMMENT: 3,
  SHOT_COMMENT: 4,
} as const;
export type LabelKind = (typeof LABEL_KIND)[keyof typeof LABEL_KIND];
/** Number of label kinds == length of every per-kind uniform array. */
export const LABEL_KIND_COUNT = 5;

/**
 * `a_flags` bitfield (a UNSIGNED_BYTE integer attribute). The shader tests these
 * bits directly; `labelTessellate.ts` sets them. Kept here because the shader is
 * the contract for their meaning.
 *  - FIRST_IN_SECTION: station label that is first in its section -> always shown
 *    (overrides decimation), mirroring the stock `isFirstInSection` filter branch.
 *  - REFERENCE: shot label of a reference shot -> collapsed when reference shots
 *    are hidden.
 *  - ALL_REFERENCE: station label / all-reference section name -> collapsed with
 *    reference shots (mirrors `allShotsReference` / `allStationsReference`).
 *  - DIM: anchored / immovable label -> drawn at 0.25 opacity (move tools).
 *  - COLLIDE_HIDE: collision loser (declutter) -> collapsed (draws nothing).
 *  - DRAG_HIDE: drag-excluded (a move tool is dragging this feature) -> collapsed.
 *    Split from COLLIDE_HIDE (Phase 5) so the two can be re-uploaded independently:
 *    a drag flip (flags-only upload) must not disturb the frozen collision result,
 *    and a collision rerun must not disturb the active drag. The shader collapses
 *    on EITHER bit, so their meaning to the fragment stage is identical.
 */
export const LABEL_FLAG = {
  FIRST_IN_SECTION: 1 << 0,
  REFERENCE: 1 << 1,
  ALL_REFERENCE: 1 << 2,
  DIM: 1 << 3,
  COLLIDE_HIDE: 1 << 4,
  DRAG_HIDE: 1 << 5,
} as const;

/** Normalized SDF value at the glyph edge (= `1 - cutoff`, cutoff 0.25). See the
 *  module header: this is MapLibre's `192/256`, not `0.5`. */
export const SDF_EDGE = 0.75;

/** Vertex-attribute names, in the order the GL layer binds them. `a_kind` and
 *  `a_flags` are INTEGER attributes (bind with `vertexAttribIPointer`,
 *  UNSIGNED_BYTE); the rest are FLOAT except `a_color` (UNSIGNED_BYTE, normalized),
 *  matching the geometry layer's idiom. */
export const LABEL_ATTRIBS = {
  anchor: 'a_anchor', // vec2 FLOAT   anchor-relative mercator (shared per label)
  offsetEm: 'a_offset_em', // vec2 FLOAT   glyph-corner offset from anchor, in em
  uv: 'a_uv', // vec2 FLOAT   atlas PIXEL coords (normalized in shader)
  color: 'a_color', // vec4 UNSIGNED_BYTE (normalized) data-driven text color
  kind: 'a_kind', // uint UNSIGNED_BYTE (integer) LABEL_KIND
  ordinal: 'a_ordinal', // float FLOAT  decimation key (shot index / station ordinal)
  flags: 'a_flags', // uint UNSIGNED_BYTE (integer) LABEL_FLAG bitfield
} as const;

/** Uniform names (documentation + a single source the GL layer can reference). */
export const LABEL_UNIFORMS = {
  matrix: 'u_matrix',
  viewport: 'u_viewport',
  atlasSize: 'u_atlas_size',
  atlas: 'u_atlas',
  fontSize: 'u_font_size',
  sdfRadius: 'u_sdf_radius',
  textSizePx: 'u_text_size_px', // float[5]
  opacity: 'u_opacity', // float[5]
  decimMod: 'u_decim_mod', // float[5]
  kindVisible: 'u_kind_visible', // float[5]
  haloColor: 'u_halo_color', // vec4[5]
  haloWidthPx: 'u_halo_width_px', // float[5]
  hideReference: 'u_hide_reference',
} as const;

// The flag-bit literals are inlined into the GLSL (a `#define` block) so the
// shader and the TS `LABEL_FLAG` table share one set of numbers by construction.
const FLAG_DEFINES = `
#define FLAG_FIRST_IN_SECTION ${LABEL_FLAG.FIRST_IN_SECTION}u
#define FLAG_REFERENCE ${LABEL_FLAG.REFERENCE}u
#define FLAG_ALL_REFERENCE ${LABEL_FLAG.ALL_REFERENCE}u
#define FLAG_DIM ${LABEL_FLAG.DIM}u
#define FLAG_COLLIDE_HIDE ${LABEL_FLAG.COLLIDE_HIDE}u
#define FLAG_DRAG_HIDE ${LABEL_FLAG.DRAG_HIDE}u
#define KIND_COUNT ${LABEL_KIND_COUNT}`;

/**
 * Label vertex shader. Projects the shared label anchor, adds the per-glyph em
 * offset scaled by the per-kind rendered text size (em -> screen px), and
 * COLLAPSES the whole glyph quad to a clipped point (`vec4(2,2,2,1)`, the
 * geometry layer's degenerate-vertex idiom) whenever the label should not draw:
 * kind toggled off / below its minzoom (`u_kind_visible`), a hide flag
 * (COLLIDE_HIDE or DRAG_HIDE), reference-hidden, or thinned out by the decimation band
 * (`mod(a_ordinal, N)`) unless it is first-in-section. All four verts of a glyph
 * share `a_anchor`/`a_kind`/`a_ordinal`/`a_flags`, so both triangles degenerate
 * together — same guarantee the line/circle collapses rely on.
 */
export const LABEL_VERTEX_SRC = `#version 300 es
precision highp float;
${FLAG_DEFINES}
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform vec2 u_atlas_size;
uniform float u_text_size_px[KIND_COUNT];
uniform float u_opacity[KIND_COUNT];
uniform float u_decim_mod[KIND_COUNT];
uniform float u_kind_visible[KIND_COUNT];
uniform float u_hide_reference;
in vec2 a_anchor;
in vec2 a_offset_em;
in vec2 a_uv;
in vec4 a_color;
in uint a_kind;
in float a_ordinal;
in uint a_flags;
out vec2 v_uv;
out vec4 v_color;
out float v_opacity;
out float v_size_px;
flat out int v_kind;
void collapse() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  v_uv = vec2(0.0);
  v_color = vec4(0.0);
  v_opacity = 0.0;
  v_size_px = 1.0;
  v_kind = 0;
}
void main() {
  int kind = int(a_kind);
  // Per-kind on/off (setShow* toggles + minzoom gate baked into the uniform).
  if (u_kind_visible[kind] < 0.5) { collapse(); return; }
  // Collision loser OR drag-excluded: either collapses the glyph.
  if ((a_flags & (FLAG_COLLIDE_HIDE | FLAG_DRAG_HIDE)) != 0u) { collapse(); return; }
  // Reference-shots hidden: collapse reference shot labels and all-reference
  // station labels / section names (mirrors the stock setFilter parity).
  if (u_hide_reference > 0.5 && (a_flags & (FLAG_REFERENCE | FLAG_ALL_REFERENCE)) != 0u) {
    collapse();
    return;
  }
  // Zoom-band decimation: keep every N-th ordinal, but a first-in-section
  // station label always shows (stock 'any(isFirstInSection, ordinal%N==0)').
  float n = u_decim_mod[kind];
  if (n > 1.5 && (a_flags & FLAG_FIRST_IN_SECTION) == 0u && mod(a_ordinal, n) >= 0.5) {
    collapse();
    return;
  }
  vec4 anchorClip = u_matrix * vec4(a_anchor, 0.0, 1.0);
  // em -> screen px via the per-kind rendered size (1 em == u_text_size_px[kind]).
  vec2 offsetPx = a_offset_em * u_text_size_px[kind];
  gl_Position = vec4(
    anchorClip.xy + offsetPx / u_viewport * 2.0 * anchorClip.w,
    anchorClip.z,
    anchorClip.w
  );
  v_uv = a_uv / u_atlas_size; // atlas px -> normalized (grow-safe)
  v_color = a_color;
  // Anchored / immovable labels dim to 0.25; folds into the per-kind opacity.
  v_opacity = ((a_flags & FLAG_DIM) != 0u ? 0.25 : 1.0) * u_opacity[kind];
  v_size_px = u_text_size_px[kind];
  v_kind = kind;
}`;

/**
 * Label fragment shader. Samples the R8 SDF atlas and resolves a size-adaptive
 * text edge + outward halo (§1 of the design). `d` (0..1) is the atlas red
 * channel, {@link SDF_EDGE} (0.75) is the glyph edge; deeper inside = higher `d`.
 * The AA half-band `gamma` and the halo edge are both expressed in SDF units via
 * `sdfPerScreenPx = u_font_size / (u_sdf_radius * v_size_px)` — the raster-px ->
 * screen-px -> SDF-unit chain — so a halo width given in SCREEN px lands at the
 * right SDF threshold at any rendered size. Output is premultiplied to match the
 * geometry layer's `fragColor = vec4(col.rgb * a, a)` convention.
 */
export const LABEL_FRAGMENT_SRC = `#version 300 es
precision highp float;
${FLAG_DEFINES}
#define SDF_EDGE ${SDF_EDGE}
uniform sampler2D u_atlas;
uniform float u_font_size;
uniform float u_sdf_radius;
uniform vec4 u_halo_color[KIND_COUNT];
uniform float u_halo_width_px[KIND_COUNT];
in vec2 v_uv;
in vec4 v_color;
in float v_opacity;
in float v_size_px;
flat in int v_kind;
out vec4 fragColor;
void main() {
  float d = texture(u_atlas, v_uv).r;
  // One screen px == this many SDF units at the current rendered size.
  float sdfPerScreenPx = u_font_size / (u_sdf_radius * max(v_size_px, 1.0));
  float gamma = 0.6 * sdfPerScreenPx; // ~0.6 px antialias half-band
  float textAlpha = smoothstep(SDF_EDGE - gamma, SDF_EDGE + gamma, d);
  // Halo extends OUTWARD (toward lower d) by its screen-px width.
  float haloWidth = u_halo_width_px[v_kind];
  float haloEdge = SDF_EDGE - haloWidth * sdfPerScreenPx;
  float haloAlpha = smoothstep(haloEdge - gamma, haloEdge + gamma, d);
  vec4 haloColor = u_halo_color[v_kind];
  vec3 rgb = mix(haloColor.rgb, v_color.rgb, textAlpha);
  // Blend the source alphas across the halo->text transition, then fold in the
  // per-kind (dimmed) opacity and the halo coverage.
  float srcA = mix(haloColor.a, v_color.a, textAlpha);
  float a = haloAlpha * srcA * v_opacity;
  fragColor = vec4(rgb * a, a);
}`;
