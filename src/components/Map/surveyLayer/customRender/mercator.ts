/**
 * Anchor-relative coordinate helpers for the custom-render prototype
 * (#customRender).
 *
 * float32 vertex positions lose precision at web-mercator scale: a cave a few
 * km across occupies a mercator span of ~1e-5, and storing absolute mercator
 * coords (~0.5) in float32 leaves only ~0.06 m of resolution, so shots would
 * visibly jitter / snap. The fix (mirroring how MapLibre keeps tile-local
 * coords small): pick an ANCHOR at the survey's mercator center, store each
 * vertex as `(mercator - anchor)` in float32 (tiny magnitude -> full float32
 * mantissa near zero), and fold the large anchor translation back into the
 * per-frame matrix computed in float64 on the CPU.
 *
 * `composeAnchorMatrix(mvp, anchor)` = `mvp * translate(anchor)`, so in the
 * vertex shader `gl_Position = u_matrix * vec4(localPos, 0, 1)` reconstructs
 * `mvp * (anchor + localPos) = mvp * mercator`. `mvp` is MapLibre's
 * `modelViewProjectionMatrix` render arg (mercator [0,1] -> clip space).
 */
import type { GpsOrigin } from '../../../../types/config';
import type { SurveyData } from '../../../../types/survey-data';
import { metersToMapCoords } from '../../../../utils/coordinates';
import { lngLatToMercator } from '../vectorTileData';

/** A 4x4 matrix in OpenGL column-major order (16 elements). */
export type Mat4 = ArrayLike<number>;

/**
 * Column-major 4x4 multiply `a * b`, computed in float64. Exposed so the
 * anchor composition can be verified against a general multiply in tests.
 */
export function mat4Multiply(a: Mat4, b: Mat4): Float64Array {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4]!;
    const b1 = b[col * 4 + 1]!;
    const b2 = b[col * 4 + 2]!;
    const b3 = b[col * 4 + 3]!;
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row]! * b0 + a[4 + row]! * b1 + a[8 + row]! * b2 + a[12 + row]! * b3;
    }
  }
  return out;
}

/**
 * Compose MapLibre's mercator matrix with an anchor translation, in float64,
 * returning a float32 matrix ready for `uniformMatrix4fv`. Result maps
 * anchor-relative mercator positions (`mercator - anchor`) straight to clip
 * space. z-translation is 0 (2d prototype).
 */
export function composeAnchorMatrix(mvp: Mat4, anchorX: number, anchorY: number): Float32Array {
  // Column-major translation matrix with translation in the last column.
  const translate = new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    anchorX, anchorY, 0, 1,
  ]);
  const composed = mat4Multiply(mvp, translate);
  return Float32Array.from(composed);
}

/**
 * Pick the anchor as the survey's mercator center (midpoint of the mercator
 * bounding box of all stations). Uses the SAME meters->lnglat->mercator pass
 * the vt build uses, so anchor and vertex coords are in one consistent space.
 * Returns `[0.5, 0.5]` (mercator world center) for an empty survey.
 */
export function computeMercatorAnchor(
  data: SurveyData,
  gpsOrigin: GpsOrigin | null,
): [number, number] {
  const n = data.stationCount;
  if (n === 0) return [0.5, 0.5];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let g = 0; g < n; g++) {
    const ll = metersToMapCoords(data.stationCoords[g * 3]!, data.stationCoords[g * 3 + 1]!, gpsOrigin);
    const [mx, my] = lngLatToMercator(ll[0], ll[1]);
    if (mx < minX) minX = mx;
    if (my < minY) minY = my;
    if (mx > maxX) maxX = mx;
    if (my > maxY) maxY = my;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}
