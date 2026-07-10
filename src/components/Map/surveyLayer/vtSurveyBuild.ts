/**
 * Direct SoA -> VtLayerData builder for the shots + stations bulk layers (#mem).
 *
 * Goal: build the shots (line-kind) and stations (point-kind) `VtLayerData`
 * straight from the `SurveyData` struct-of-arrays, with NO intermediate
 * `GeoJSON.Feature[]` graph and a SINGLE meters->mercator projection pass. The
 * output is functionally identical to composing the two legacy stages:
 *   vtLinesFromFeatures(buildSurveyFeatures(...).shotFeatures)   (shots)
 *   vtPointsFromFeatures(buildSurveyFeatures(...).stationFeatures) (stations)
 * for the same inputs (same ids, same coords ===, same per-group props, same
 * offset arrays, same group count/order). The parity test
 * (`__tests__/vtSurveyBuild.test.ts`) pins that equivalence.
 *
 * Two consumers:
 *   1. The narrow granularity swap (mode entry/exit) rebuilds ONLY shots +
 *      stations with this, leaving the ~178k labels / gradients / section-labels
 *      / loop-closures resident (they are invariant to merged-vs-per-feature).
 *   2. Anyone needing shots/stations without the full feature graph.
 *
 * Palette: the caller passes a `VtPalette` interner. Seed it with the resident
 * palette (`makeVtPalette(this.colorPalette)`) so shot/station `colorIndex`
 * values match the last full build EXACTLY. This matters because a full build in
 * depth-gradient mode interns gradient-segment colors INTERLEAVED with shot
 * colors, so a shots+stations-only build cannot reproduce the resident palette's
 * index order from an empty seed. Seeding sidesteps that: every shot/station
 * color is already present at its resident index, nothing is appended on a pure
 * toggle, and the palette never shrinks (keeps gradient/label indices valid).
 */
import type { GpsOrigin } from '../../../types/config';
import {
  type SurveyData,
  type SectionMetadata,
  SHOT_FLAG_IS_REFERENCE,
  STATION_FLAG_IS_ZERO_DATUM,
} from '../../../types/survey-data';
import { metersToMapCoords } from '../../../utils/coordinates';
import { encodeFeatureId } from '../../../utils/ids';
import {
  resolveShotDisplayColor,
  resolveStationDisplayColor,
  resolveStationStrokeColor,
  type DisplayColorContext,
} from './features';
import { lngLatToMercator, type VtLayerData, type VtPropValue } from './vectorTileData';

/**
 * Append-only color interner mirroring `buildSurveyFeatures`' `paletteIndex`:
 * `indexOf(color)` returns the color's existing index or appends it. Seed with a
 * resident palette to reuse its indices; the seed's first-occurrence order wins.
 */
export interface VtPalette {
  colors: string[];
  indexOf(color: string): number;
}

/** Build a `VtPalette`, optionally pre-populated from `seed` (append-only). */
export function makeVtPalette(seed?: readonly string[]): VtPalette {
  const colors: string[] = seed ? [...seed] : [];
  const index = new Map<string, number>();
  for (let i = 0; i < colors.length; i++) {
    // First occurrence wins (matches paletteIndex); resident palettes are
    // already deduped so this is just a straight fill in practice.
    if (!index.has(colors[i]!)) index.set(colors[i]!, i);
  }
  return {
    colors,
    indexOf(color: string): number {
      let idx = index.get(color);
      if (idx === undefined) {
        idx = colors.length;
        colors.push(color);
        index.set(color, idx);
      }
      return idx;
    },
  };
}

export interface ShotStationVt {
  shots: VtLayerData;
  stations: VtLayerData;
  /** The interner's colors after the build (== `palette.colors`). */
  palette: string[];
}

// ─── Internal assemblers (mirror vectorTileData's two-pass fill) ────────────

/** One accumulated line group: id + props + its lines as flat [x,y,x,y,...]
 *  mercator coords (already projected). */
interface LineGroup {
  id: number;
  props: Record<string, VtPropValue>;
  lines: number[][];
}

/** One accumulated point group: id + props + its points as a flat
 *  [x,y,x,y,...] mercator list (already projected). */
interface PointGroup {
  id: number;
  props: Record<string, VtPropValue>;
  points: number[];
}

/** Assemble a line-kind VtLayerData from ordered groups. Byte-for-byte the same
 *  layout `vtLinesFromFeatures` produces (used only by the merged path; the
 *  per-feature path fills typed arrays directly to avoid the group transient). */
function assembleLine(groups: LineGroup[]): VtLayerData {
  let lineCount = 0;
  let pointCount = 0;
  for (const g of groups) {
    lineCount += g.lines.length;
    for (const line of g.lines) pointCount += line.length / 2;
  }
  const groupCount = groups.length;
  const ids = new Float64Array(groupCount);
  const props: Array<Record<string, VtPropValue>> = new Array(groupCount);
  const coords = new Float64Array(pointCount * 2);
  const groupPointOffsets = new Uint32Array(groupCount + 1);
  const lineOffsets = new Uint32Array(lineCount + 1);
  const groupLineOffsets = new Uint32Array(groupCount + 1);

  let gi = 0;
  let li = 0;
  let p = 0;
  for (const g of groups) {
    ids[gi] = g.id;
    props[gi] = g.props;
    groupPointOffsets[gi] = p;
    groupLineOffsets[gi] = li;
    for (const line of g.lines) {
      lineOffsets[li++] = p;
      for (let k = 0; k < line.length; k += 2) {
        coords[p * 2] = line[k]!;
        coords[p * 2 + 1] = line[k + 1]!;
        p++;
      }
    }
    gi++;
  }
  groupPointOffsets[groupCount] = p;
  lineOffsets[lineCount] = p;
  groupLineOffsets[groupCount] = li;
  return { kind: 'line', ids, props, coords, groupPointOffsets, lineOffsets, groupLineOffsets };
}

/** Assemble a point-kind VtLayerData from ordered groups (merged path). */
function assemblePoint(groups: PointGroup[]): VtLayerData {
  let pointCount = 0;
  for (const g of groups) pointCount += g.points.length / 2;
  const groupCount = groups.length;
  const ids = new Float64Array(groupCount);
  const props: Array<Record<string, VtPropValue>> = new Array(groupCount);
  const coords = new Float64Array(pointCount * 2);
  const groupPointOffsets = new Uint32Array(groupCount + 1);

  let gi = 0;
  let p = 0;
  for (const g of groups) {
    ids[gi] = g.id;
    props[gi] = g.props;
    groupPointOffsets[gi] = p;
    for (let k = 0; k < g.points.length; k += 2) {
      coords[p * 2] = g.points[k]!;
      coords[p * 2 + 1] = g.points[k + 1]!;
      p++;
    }
    gi++;
  }
  groupPointOffsets[groupCount] = p;
  return { kind: 'point', ids, props, coords, groupPointOffsets };
}

// ─── Combined builder ────────────────────────────────────────────────────────

/**
 * Build the shots + stations `VtLayerData` directly from the SoA.
 *
 * Shots run first (they also fill `stationsWithNonReferenceShot`, which the
 * stations pass reads for `allShotsReference`), then stations. `mergeFeatures`
 * selects merged MultiLineString/MultiPoint groups (steady state) vs per-feature
 * LineString/Point features (per-item feature-state modes). `palette` is the
 * caller-owned interner (seed it to reuse resident indices).
 */
export function buildShotStationVt(
  data: SurveyData,
  gpsOrigin: GpsOrigin | null,
  colorCtx: DisplayColorContext,
  mergeFeatures: boolean,
  palette: VtPalette,
): ShotStationVt {
  // (sectionId, stationIndex) -> global station index. Built once, O(stations).
  const stationLookup = new Map<number, Map<number, number>>();
  for (let g = 0; g < data.stationCount; g++) {
    const sid = data.stationSectionIds[g]!;
    let inner = stationLookup.get(sid);
    if (!inner) {
      inner = new Map();
      stationLookup.set(sid, inner);
    }
    inner.set(data.stationIndices[g]!, g);
  }

  // sectionId -> SectionMetadata for the stations pass' color lookup.
  const sectionMetaById = new Map<number, SectionMetadata>();
  for (const s of data.sections) sectionMetaById.set(s.id, s);

  // Project meters -> mercator [0,1] via the exact same two functions the legacy
  // path composed (metersToMapCoords then lngLatToMercator), so coords are ===.
  const project = (x: number, y: number): [number, number] => {
    const ll = metersToMapCoords(x, y, gpsOrigin);
    return lngLatToMercator(ll[0], ll[1]);
  };

  // ─── Pre-pass: fill the non-reference-shot set + count valid shots ─────────
  // Cheap (no color resolution, no projection). Mirrors the add-to-set logic in
  // the shots loop (only VALID, non-reference shots contribute). The valid count
  // exact-sizes the per-feature typed arrays.
  const stationsWithNonReferenceShot = new Set<string>();
  let validShotCount = 0;
  for (const section of data.sections) {
    const innerStationMap = stationLookup.get(section.id);
    if (!innerStationMap) continue;
    for (let i = 0; i < section.shotCount; i++) {
      if (innerStationMap.get(i) === undefined || innerStationMap.get(i + 1) === undefined) continue;
      validShotCount++;
      const isReference = (data.shotFlags[section.shotOffset + i]! & SHOT_FLAG_IS_REFERENCE) !== 0;
      if (!isReference) {
        stationsWithNonReferenceShot.add(`${section.id}:${i}`);
        stationsWithNonReferenceShot.add(`${section.id}:${i + 1}`);
      }
    }
  }

  const shots = mergeFeatures
    ? buildShotsMerged(data, colorCtx, stationLookup, palette, project)
    : buildShotsPerFeature(data, colorCtx, stationLookup, palette, project, validShotCount);

  const stations = mergeFeatures
    ? buildStationsMerged(data, colorCtx, sectionMetaById, stationsWithNonReferenceShot, palette, project)
    : buildStationsPerFeature(data, colorCtx, sectionMetaById, stationsWithNonReferenceShot, palette, project);

  return { shots, stations, palette: palette.colors };
}

/** Per-feature shots: one LineString (2 points) per valid shot, in section then
 *  shot order. Direct typed-array fill (no coordinate transient). */
function buildShotsPerFeature(
  data: SurveyData,
  colorCtx: DisplayColorContext,
  stationLookup: Map<number, Map<number, number>>,
  palette: VtPalette,
  project: (x: number, y: number) => [number, number],
  validShotCount: number,
): VtLayerData {
  const n = validShotCount;
  const ids = new Float64Array(n);
  const props: Array<Record<string, VtPropValue>> = new Array(n);
  const coords = new Float64Array(n * 4); // n lines * 2 points * 2 coords
  const groupPointOffsets = new Uint32Array(n + 1);
  const lineOffsets = new Uint32Array(n + 1);
  const groupLineOffsets = new Uint32Array(n + 1);

  let gi = 0;
  for (const section of data.sections) {
    const innerStationMap = stationLookup.get(section.id);
    if (!innerStationMap) continue;
    for (let i = 0; i < section.shotCount; i++) {
      const fromGlobal = innerStationMap.get(i);
      const toGlobal = innerStationMap.get(i + 1);
      if (fromGlobal === undefined || toGlobal === undefined) continue;
      const shotGlobalIdx = section.shotOffset + i;
      const shotId = data.shotIds[shotGlobalIdx]!;
      const isReference = (data.shotFlags[shotGlobalIdx]! & SHOT_FLAG_IS_REFERENCE) !== 0;
      const colorIndex = palette.indexOf(
        resolveShotDisplayColor(data, section.color, shotGlobalIdx, colorCtx),
      );
      const featureId = encodeFeatureId(section.id, shotId);
      const [fx, fy] = project(data.stationCoords[fromGlobal * 3]!, data.stationCoords[fromGlobal * 3 + 1]!);
      const [tx, ty] = project(data.stationCoords[toGlobal * 3]!, data.stationCoords[toGlobal * 3 + 1]!);

      ids[gi] = featureId;
      props[gi] = { featureId, sectionId: section.id, shotId, colorIndex, isReference };
      const startPoint = gi * 2;
      groupPointOffsets[gi] = startPoint;
      lineOffsets[gi] = startPoint;
      groupLineOffsets[gi] = gi;
      coords[startPoint * 2] = fx;
      coords[startPoint * 2 + 1] = fy;
      coords[(startPoint + 1) * 2] = tx;
      coords[(startPoint + 1) * 2 + 1] = ty;
      gi++;
    }
  }
  groupPointOffsets[n] = n * 2;
  lineOffsets[n] = n * 2;
  groupLineOffsets[n] = n;
  return { kind: 'line', ids, props, coords, groupPointOffsets, lineOffsets, groupLineOffsets };
}

/** Merged shots: one MultiLineString per (colorIndex, isReference) group per
 *  section, in first-seen order; group `featureId` is a GLOBAL running seq. */
function buildShotsMerged(
  data: SurveyData,
  colorCtx: DisplayColorContext,
  stationLookup: Map<number, Map<number, number>>,
  palette: VtPalette,
  project: (x: number, y: number) => [number, number],
): VtLayerData {
  const groups: LineGroup[] = [];
  let shotGroupSeq = 0;
  for (const section of data.sections) {
    const innerStationMap = stationLookup.get(section.id);
    if (!innerStationMap) continue;
    const sectionShotGroups = new Map<string, { colorIndex: number; isReference: boolean; lines: number[][] }>();
    for (let i = 0; i < section.shotCount; i++) {
      const fromGlobal = innerStationMap.get(i);
      const toGlobal = innerStationMap.get(i + 1);
      if (fromGlobal === undefined || toGlobal === undefined) continue;
      const shotGlobalIdx = section.shotOffset + i;
      const isReference = (data.shotFlags[shotGlobalIdx]! & SHOT_FLAG_IS_REFERENCE) !== 0;
      const colorIndex = palette.indexOf(
        resolveShotDisplayColor(data, section.color, shotGlobalIdx, colorCtx),
      );
      const [fx, fy] = project(data.stationCoords[fromGlobal * 3]!, data.stationCoords[fromGlobal * 3 + 1]!);
      const [tx, ty] = project(data.stationCoords[toGlobal * 3]!, data.stationCoords[toGlobal * 3 + 1]!);
      const key = `${colorIndex}|${isReference ? 1 : 0}`;
      let group = sectionShotGroups.get(key);
      if (!group) {
        group = { colorIndex, isReference, lines: [] };
        sectionShotGroups.set(key, group);
      }
      group.lines.push([fx, fy, tx, ty]);
    }
    for (const group of sectionShotGroups.values()) {
      groups.push({
        id: shotGroupSeq,
        props: {
          featureId: shotGroupSeq,
          sectionId: section.id,
          colorIndex: group.colorIndex,
          isReference: group.isReference,
        },
        lines: group.lines,
      });
      shotGroupSeq++;
    }
  }
  return assembleLine(groups);
}

/** Per-feature stations: one Point per global station, in global index order. */
function buildStationsPerFeature(
  data: SurveyData,
  colorCtx: DisplayColorContext,
  sectionMetaById: Map<number, SectionMetadata>,
  stationsWithNonReferenceShot: Set<string>,
  palette: VtPalette,
  project: (x: number, y: number) => [number, number],
): VtLayerData {
  const n = data.stationCount;
  const ids = new Float64Array(n);
  const props: Array<Record<string, VtPropValue>> = new Array(n);
  const coords = new Float64Array(n * 2);
  const groupPointOffsets = new Uint32Array(n + 1);

  const stationDefault = colorCtx.themeColors.stationDefault;
  for (let g = 0; g < n; g++) {
    const sectionId = data.stationSectionIds[g]!;
    const stationIndex = data.stationIndices[g]!;
    const sectionColor = sectionMetaById.get(sectionId)?.color ?? stationDefault;
    const isZeroDatum = (data.stationFlags[g]! & STATION_FLAG_IS_ZERO_DATUM) !== 0;
    const colorIndex = palette.indexOf(resolveStationDisplayColor(data, sectionColor, g, colorCtx));
    const strokeColorIndex = palette.indexOf(resolveStationStrokeColor(isZeroDatum, colorCtx));
    const allShotsReference = !stationsWithNonReferenceShot.has(`${sectionId}:${stationIndex}`);
    const featureId = encodeFeatureId(sectionId, stationIndex);
    const [px, py] = project(data.stationCoords[g * 3]!, data.stationCoords[g * 3 + 1]!);

    ids[g] = featureId;
    props[g] = { featureId, sectionId, stationIndex, isZeroDatum, colorIndex, strokeColorIndex, allShotsReference };
    groupPointOffsets[g] = g;
    coords[g * 2] = px;
    coords[g * 2 + 1] = py;
  }
  groupPointOffsets[n] = n;
  return { kind: 'point', ids, props, coords, groupPointOffsets };
}

/** Merged stations: one MultiPoint per (sectionId, colorIndex, strokeColorIndex,
 *  isZeroDatum, allShotsReference) group, in first-seen order over all stations;
 *  group `featureId` is a GLOBAL running seq. */
function buildStationsMerged(
  data: SurveyData,
  colorCtx: DisplayColorContext,
  sectionMetaById: Map<number, SectionMetadata>,
  stationsWithNonReferenceShot: Set<string>,
  palette: VtPalette,
  project: (x: number, y: number) => [number, number],
): VtLayerData {
  type Acc = {
    sectionId: number;
    colorIndex: number;
    strokeColorIndex: number;
    isZeroDatum: boolean;
    allShotsReference: boolean;
    points: number[];
  };
  const stationGroups = new Map<string, Acc>();
  const stationDefault = colorCtx.themeColors.stationDefault;
  for (let g = 0; g < data.stationCount; g++) {
    const sectionId = data.stationSectionIds[g]!;
    const stationIndex = data.stationIndices[g]!;
    const sectionColor = sectionMetaById.get(sectionId)?.color ?? stationDefault;
    const isZeroDatum = (data.stationFlags[g]! & STATION_FLAG_IS_ZERO_DATUM) !== 0;
    const colorIndex = palette.indexOf(resolveStationDisplayColor(data, sectionColor, g, colorCtx));
    const strokeColorIndex = palette.indexOf(resolveStationStrokeColor(isZeroDatum, colorCtx));
    const allShotsReference = !stationsWithNonReferenceShot.has(`${sectionId}:${stationIndex}`);
    const [px, py] = project(data.stationCoords[g * 3]!, data.stationCoords[g * 3 + 1]!);
    const key = `${sectionId}|${colorIndex}|${strokeColorIndex}|${isZeroDatum ? 1 : 0}|${allShotsReference ? 1 : 0}`;
    let group = stationGroups.get(key);
    if (!group) {
      group = { sectionId, colorIndex, strokeColorIndex, isZeroDatum, allShotsReference, points: [] };
      stationGroups.set(key, group);
    }
    group.points.push(px, py);
  }
  const groups: PointGroup[] = [];
  let stationGroupSeq = 0;
  for (const group of stationGroups.values()) {
    groups.push({
      id: stationGroupSeq,
      props: {
        featureId: stationGroupSeq,
        sectionId: group.sectionId,
        isZeroDatum: group.isZeroDatum,
        colorIndex: group.colorIndex,
        strokeColorIndex: group.strokeColorIndex,
        allShotsReference: group.allShotsReference,
      },
      points: group.points,
    });
    stationGroupSeq++;
  }
  return assemblePoint(groups);
}
