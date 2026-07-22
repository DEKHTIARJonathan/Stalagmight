/**
 * SurveyData -> label descriptors -> per-glyph WebGL vertex buffers
 * (#customRender labels, Phase 1).
 *
 * Pure (no GL, no DOM beyond the injected {@link GlyphAtlas}), so the whole
 * label-buffer story is unit-testable in the `node` env — the GL layer (Phase 2)
 * only uploads what {@link buildLabelBuffers} returns. Sibling of `tessellate.ts`
 * (lines/circles): the same anchor-relative-mercator float32 positions +
 * per-glyph-quad-as-4-verts + `UNSIGNED_INT` indices, and the same single-writer
 * discipline ({@link emitLabel} is the one function that stamps a label's glyph
 * quads, mirroring `emitLineSection` / `emitStation`).
 *
 * TWO STAGES:
 *  1. {@link buildLabelDescriptors} walks the SoA once and emits a
 *     {@link LabelDescriptor} per label (5 kinds), computing the anchor
 *     (anchor-relative mercator, exactly the projection `features.ts` uses), the
 *     text + color (via the shared `labelText.ts` helpers -> parity), the
 *     decimation ordinal, and the static flag bits (reference / all-reference /
 *     first-in-section). Interaction flags (DIM / HIDE) default 0 here and are a
 *     later phase's concern.
 *  2. {@link buildLabelBuffers} shapes each descriptor's text (`labelLayout.ts`)
 *     and stamps its glyph quads into one set of typed arrays.
 *
 * Viewport scoping + collision (which labels to include) are a later phase; this
 * module builds whatever descriptor set it is given, so a Phase-4 viewport filter
 * simply pre-filters the descriptor list.
 */
import type { GpsOrigin, DecimalPrecision } from '../../../../types/config';
import { type SurveyData, SHOT_FLAG_IS_REFERENCE } from '../../../../types/survey-data';
import { metersToMapCoords } from '../../../../utils/coordinates';
import { lngLatToMercator } from '../vectorTileData';
import { packCssColor, type Rgba8 } from './colorPack';
import { buildStationLookup, computeStationAllReference, projectStationsRel } from './tessellate';
import { LABEL_KIND, LABEL_FLAG, type LabelKind } from './labelShaders';
import { shapeLabel, type ShapedLabel } from './labelLayout';
import type { GlyphAtlas } from './glyphAtlas';
import {
  formatShotLabel,
  formatStationLabel,
  formatSectionLabel,
  formatCommentLabel,
  resolveShotLabelColor,
  resolveStationLabelColor,
  resolveSectionLabelColor,
  type LabelColorContext,
} from './labelText';

/**
 * One label to render: kind (indexes every per-kind uniform + `labelLayout`
 * anchor/offset), its text, its anchor in anchor-relative mercator, its packed
 * data color, its decimation ordinal, and its static {@link LABEL_FLAG} bits.
 */
export interface LabelDescriptor {
  kind: LabelKind;
  text: string;
  /** Anchor in anchor-relative mercator (`mercator - anchor`), shared by every
   *  glyph of this label. */
  anchorX: number;
  anchorY: number;
  color: Rgba8;
  /** Decimation key: shot running index (shot labels) / station global ordinal
   *  (station labels); 0 for kinds without decimation. */
  ordinal: number;
  /** {@link LABEL_FLAG} bitfield. */
  flags: number;
}

/** Inputs `buildLabelDescriptors` needs beyond the survey geometry: the shared
 *  label color context + the number-format precision. */
export interface LabelBuildContext {
  colorCtx: LabelColorContext;
  precision?: DecimalPrecision | undefined;
}

/**
 * Per-glyph-vertex label buffers (§3 of the design). One label's glyphs share
 * `anchor` / `color` / `kind` / `ordinal` / `flags`; `offsetEm` (em, +y up) and
 * `uv` (atlas px) vary per glyph corner. `kind` / `flags` are integer attributes
 * (bind with `vertexAttribIPointer`, UNSIGNED_BYTE); the rest are FLOAT except
 * `color` (UNSIGNED_BYTE, normalized).
 */
export interface LabelBuffers {
  glyphCount: number;
  vertexCount: number;
  /** Label anchor (anchor-relative mercator), `vertexCount*2`. */
  anchor: Float32Array;
  /** Glyph-corner offset from the anchor, in em (+x right, +y up), `vertexCount*2`. */
  offsetEm: Float32Array;
  /** Atlas PIXEL coords (normalized in the shader), `vertexCount*2`. */
  uv: Float32Array;
  /** Per-vertex text color RGBA8, `vertexCount*4`. */
  color: Uint8Array;
  /** Per-vertex label kind (0..4), `vertexCount`. */
  kind: Uint8Array;
  /** Per-vertex decimation ordinal, `vertexCount`. */
  ordinal: Float32Array;
  /** Per-vertex {@link LABEL_FLAG} bitfield, `vertexCount`. */
  flags: Uint8Array;
  /** Two triangles per glyph, `glyphCount*6`, `UNSIGNED_INT`. */
  indices: Uint32Array;
  /** Total attribute + index bytes (for cost logging). */
  byteLength: number;
}

/** Project a meters (x, y) point to anchor-relative mercator, the exact pass
 *  `features.ts` / `tessellate.ts` use. */
function projectMeters(
  x: number,
  y: number,
  gpsOrigin: GpsOrigin | null,
  anchorX: number,
  anchorY: number,
): [number, number] {
  const ll = metersToMapCoords(x, y, gpsOrigin);
  const [mx, my] = lngLatToMercator(ll[0], ll[1]);
  return [mx - anchorX, my - anchorY];
}

/**
 * Walk the SoA once and emit a {@link LabelDescriptor} for every label the stock
 * layers would build: shot labels (+ shot comments), station labels (+ station
 * comments), and section names. Reproduces `features.ts`' anchor placement,
 * ordinals, all-reference / first-in-section predicates, and (via `labelText.ts`)
 * text + color exactly. `anchorX` / `anchorY` is the survey mercator anchor
 * (`computeMercatorAnchor`); all descriptor anchors are relative to it.
 */
export function buildLabelDescriptors(
  data: SurveyData,
  gpsOrigin: GpsOrigin | null,
  anchorX: number,
  anchorY: number,
  ctx: LabelBuildContext,
  kinds?: ReadonlySet<LabelKind>,
): LabelDescriptor[] {
  const descriptors: LabelDescriptor[] = [];
  // Kind filter (Phase 2 builds station labels only; Phase 3 drops the arg to
  // build all five). Absent = every kind, so existing callers are unchanged.
  const wants = (k: LabelKind): boolean => kinds === undefined || kinds.has(k);
  const lookup = buildStationLookup(data);
  // allRef[g] === 1 <=> every shot touching station g is a reference shot (or it
  // has none). Equivalently allRef[g] === 0 <=> g has a non-reference shot — the
  // `stationsWithNonReferenceShot` predicate features.ts uses.
  const allRef = computeStationAllReference(data, lookup);
  const stationRel = projectStationsRel(data, gpsOrigin, anchorX, anchorY);
  const { colorCtx } = ctx;

  // ─── Shot labels (+ shot comments) ─────────────────────────────
  const wantShotLabel = wants(LABEL_KIND.SHOT_LABEL);
  const wantShotComment = wants(LABEL_KIND.SHOT_COMMENT);
  let globalShotOrdinal = 0;
  if (wantShotLabel || wantShotComment) for (const section of data.sections) {
    const inner = lookup.get(section.id);
    if (!inner) continue;
    for (let i = 0; i < section.shotCount; i++) {
      const shotGlobalIdx = section.shotOffset + i;
      const fromG = inner.get(i);
      const toG = inner.get(i + 1);
      if (fromG === undefined || toG === undefined) continue;
      const isRef = (data.shotFlags[shotGlobalIdx]! & SHOT_FLAG_IS_REFERENCE) !== 0;
      const fx = data.stationCoords[fromG * 3]!;
      const fy = data.stationCoords[fromG * 3 + 1]!;
      const fz = data.stationCoords[fromG * 3 + 2]!;
      const tx = data.stationCoords[toG * 3]!;
      const ty = data.stationCoords[toG * 3 + 1]!;
      const tz = data.stationCoords[toG * 3 + 2]!;
      // Text uses the station-z average (labelDepth); color uses the shot
      // depth_in/out average (avgDepth) — two different depths, per features.ts.
      const labelDepth = (fz + tz) / 2;
      const avgDepth = (data.shotDepthIn[shotGlobalIdx]! + data.shotDepthOut[shotGlobalIdx]!) / 2;
      const azimuthIn = data.shotAzimuthIn[shotGlobalIdx]!;
      const length = data.shotLength[shotGlobalIdx]!;
      const [ax, ay] = projectMeters((fx + tx) / 2, (fy + ty) / 2, gpsOrigin, anchorX, anchorY);
      if (wantShotLabel) descriptors.push({
        kind: LABEL_KIND.SHOT_LABEL,
        text: formatShotLabel(azimuthIn, length, labelDepth, ctx.precision),
        anchorX: ax,
        anchorY: ay,
        color: packCssColor(resolveShotLabelColor(avgDepth, colorCtx)),
        ordinal: globalShotOrdinal,
        flags: isRef ? LABEL_FLAG.REFERENCE : 0,
      });
      const shotComment = wantShotComment ? data.shotComments.get(shotGlobalIdx) : undefined;
      if (shotComment !== undefined) {
        descriptors.push({
          kind: LABEL_KIND.SHOT_COMMENT,
          text: formatCommentLabel(shotComment),
          anchorX: ax,
          anchorY: ay,
          color: packCssColor(colorCtx.labelColor),
          ordinal: 0,
          flags: 0,
        });
      }
      globalShotOrdinal++;
    }
  }

  // ─── Station labels (+ station comments) ───────────────────────
  const wantStationLabel = wants(LABEL_KIND.STATION_LABEL);
  const wantStationComment = wants(LABEL_KIND.STATION_COMMENT);
  if (wantStationLabel || wantStationComment) {
    // Per-section min station index == the "first in section" predicate.
    const sectionMinIndex = new Map<number, number>();
    for (let g = 0; g < data.stationCount; g++) {
      const sid = data.stationSectionIds[g]!;
      const idx = data.stationIndices[g]!;
      const cur = sectionMinIndex.get(sid);
      if (cur === undefined || idx < cur) sectionMinIndex.set(sid, idx);
    }
    for (let g = 0; g < data.stationCount; g++) {
      const sid = data.stationSectionIds[g]!;
      const stationIndex = data.stationIndices[g]!;
      const z = data.stationCoords[g * 3 + 2]!;
      let flags = 0;
      if (stationIndex === sectionMinIndex.get(sid)) flags |= LABEL_FLAG.FIRST_IN_SECTION;
      if (allRef[g] === 1) flags |= LABEL_FLAG.ALL_REFERENCE;
      const ax = stationRel[g * 2]!;
      const ay = stationRel[g * 2 + 1]!;
      if (wantStationLabel) descriptors.push({
        kind: LABEL_KIND.STATION_LABEL,
        text: formatStationLabel(stationIndex),
        anchorX: ax,
        anchorY: ay,
        color: packCssColor(resolveStationLabelColor(z, colorCtx)),
        ordinal: g,
        flags,
      });
      const stationComment = wantStationComment ? data.stationComments.get(g) : undefined;
      if (stationComment !== undefined) {
        descriptors.push({
          kind: LABEL_KIND.STATION_COMMENT,
          text: formatCommentLabel(stationComment),
          anchorX: ax,
          anchorY: ay,
          color: packCssColor(colorCtx.labelColor),
          ordinal: 0,
          flags: 0,
        });
      }
    }
  }

  // ─── Section names ─────────────────────────────────────────────
  if (wants(LABEL_KIND.SECTION_NAME)) for (const section of data.sections) {
    const inner = lookup.get(section.id);
    if (!inner || inner.size === 0) continue;
    // Prefer the first NON-reference station (so the name doesn't float when
    // reference shots are hidden); fall back to the first station overall.
    let anchorGlobal: number | undefined;
    let anchorStationIdx = Infinity;
    let foundNonRef = false;
    for (const [stIdx, gIdx] of inner.entries()) {
      const hasNonRef = allRef[gIdx] === 0;
      if (foundNonRef && !hasNonRef) continue;
      if (hasNonRef && !foundNonRef) {
        foundNonRef = true;
        anchorStationIdx = Infinity; // restart the min search among non-ref stations
      }
      if (stIdx < anchorStationIdx) {
        anchorStationIdx = stIdx;
        anchorGlobal = gIdx;
      }
    }
    if (anchorGlobal === undefined) continue;
    const allStationsReference = !foundNonRef;
    descriptors.push({
      kind: LABEL_KIND.SECTION_NAME,
      text: formatSectionLabel(section.name),
      anchorX: stationRel[anchorGlobal * 2]!,
      anchorY: stationRel[anchorGlobal * 2 + 1]!,
      color: packCssColor(resolveSectionLabelColor(section.color)),
      ordinal: 0,
      flags: allStationsReference ? LABEL_FLAG.ALL_REFERENCE : 0,
    });
  }

  return descriptors;
}

// Per-glyph corner template: v0 top-left, v1 top-right, v2 bottom-left,
// v3 bottom-right. `useR` picks xR over xL; `useB` picks yBot over yTop.
const CORNER_USE_R = [0, 1, 0, 1];
const CORNER_USE_B = [0, 0, 1, 1];

/**
 * Stamp one shaped label's glyph quads into `b` starting at glyph `startGlyph`,
 * returning the next free glyph index. The single writer (mirrors
 * `emitLineSection` / `emitStation`): all 4 verts of a glyph share the label's
 * anchor / color / kind / ordinal / flags; `offsetEm` + `uv` come from the
 * shaped glyph corners. Two-triangle winding `0,1,2, 2,1,3` matches the geometry
 * layer.
 */
export function emitLabel(
  b: LabelBuffers,
  startGlyph: number,
  shaped: ShapedLabel,
  desc: LabelDescriptor,
): number {
  const { anchor, offsetEm, uv, color, kind, ordinal, flags, indices } = b;
  const [cr, cg, cb, ca] = desc.color;
  let glyph = startGlyph;
  for (const g of shaped.glyphs) {
    const base = glyph * 4;
    for (let c = 0; c < 4; c++) {
      const v = base + c;
      const useR = CORNER_USE_R[c]!;
      const useB = CORNER_USE_B[c]!;
      anchor[v * 2] = desc.anchorX;
      anchor[v * 2 + 1] = desc.anchorY;
      offsetEm[v * 2] = useR ? g.xR : g.xL;
      offsetEm[v * 2 + 1] = useB ? g.yBot : g.yTop;
      uv[v * 2] = useR ? g.ax + g.aw : g.ax;
      uv[v * 2 + 1] = useB ? g.ay + g.ah : g.ay;
      color[v * 4] = cr;
      color[v * 4 + 1] = cg;
      color[v * 4 + 2] = cb;
      color[v * 4 + 3] = ca;
      kind[v] = desc.kind;
      ordinal[v] = desc.ordinal;
      flags[v] = desc.flags;
    }
    const io = glyph * 6;
    indices[io] = base;
    indices[io + 1] = base + 1;
    indices[io + 2] = base + 2;
    indices[io + 3] = base + 2;
    indices[io + 4] = base + 1;
    indices[io + 5] = base + 3;
    glyph++;
  }
  return glyph;
}

/**
 * Shape every descriptor and build the per-glyph label buffers. Allocates once
 * to the exact total glyph count, then stamps each label via {@link emitLabel}.
 */
export function buildLabelBuffers(descriptors: LabelDescriptor[], atlas: GlyphAtlas): LabelBuffers {
  const shaped: ShapedLabel[] = new Array(descriptors.length);
  let glyphCount = 0;
  for (let i = 0; i < descriptors.length; i++) {
    const s = shapeLabel(descriptors[i]!.text, descriptors[i]!.kind, atlas);
    shaped[i] = s;
    glyphCount += s.glyphCount;
  }

  const vertexCount = glyphCount * 4;
  const anchor = new Float32Array(vertexCount * 2);
  const offsetEm = new Float32Array(vertexCount * 2);
  const uv = new Float32Array(vertexCount * 2);
  const color = new Uint8Array(vertexCount * 4);
  const kind = new Uint8Array(vertexCount);
  const ordinal = new Float32Array(vertexCount);
  const flags = new Uint8Array(vertexCount);
  const indices = new Uint32Array(glyphCount * 6);
  const byteLength =
    anchor.byteLength +
    offsetEm.byteLength +
    uv.byteLength +
    color.byteLength +
    kind.byteLength +
    ordinal.byteLength +
    flags.byteLength +
    indices.byteLength;
  const b: LabelBuffers = {
    glyphCount,
    vertexCount,
    anchor,
    offsetEm,
    uv,
    color,
    kind,
    ordinal,
    flags,
    indices,
    byteLength,
  };

  let cursor = 0;
  for (let i = 0; i < descriptors.length; i++) {
    cursor = emitLabel(b, cursor, shaped[i]!, descriptors[i]!);
  }
  return b;
}
