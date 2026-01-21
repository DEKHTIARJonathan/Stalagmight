/**
 * Pure utility functions for export depth coloring.
 * Extracted for testability - matches Rust backend's color interpolation.
 */

/** Color stop for multi-stop gradient */
export interface ColorStop {
  position: number;
  color: string;
}

/** Depth range for normalization */
export interface DepthRange {
  min: number;
  max: number;
}

/** Preset colors configuration */
export interface DepthPresetColors {
  stops: ColorStop[];
}

/**
 * Parse hex color to RGB components.
 * NOTE: Adds `.trim()` for robustness (Rust's trim_start_matches('#') doesn't strip whitespace).
 * This is intentional as frontend may receive user-edited values with trailing spaces.
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  // Strip whitespace (for robustness) and all leading # characters
  const cleanHex = hex.trim().replace(/^#+/, '');
  if (cleanHex.length < 6) {
    return { r: 0, g: 0, b: 0 };
  }
  return {
    r: parseInt(cleanHex.slice(0, 2), 16) || 0,
    g: parseInt(cleanHex.slice(2, 4), 16) || 0,
    b: parseInt(cleanHex.slice(4, 6), 16) || 0,
  };
}

/**
 * Convert RGB to hex color string.
 */
export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Convert RGB to HSL color space.
 * Returns [hue: 0-360, saturation: 0-1, lightness: 0-1]
 */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;

  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const l = (max + min) / 2;

  if (Math.abs(max - min) < Number.EPSILON) {
    // Achromatic (gray)
    return [0, 0, l];
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h: number;
  if (Math.abs(max - rNorm) < Number.EPSILON) {
    h = (gNorm - bNorm) / d;
    if (gNorm < bNorm) h += 6;
    h /= 6;
  } else if (Math.abs(max - gNorm) < Number.EPSILON) {
    h = ((bNorm - rNorm) / d + 2) / 6;
  } else {
    h = ((rNorm - gNorm) / d + 4) / 6;
  }

  return [h * 360, s, l];
}

/**
 * Helper for HSL to RGB conversion.
 */
function hueToRgb(p: number, q: number, t: number): number {
  let tNorm = t;
  if (tNorm < 0) tNorm += 1;
  if (tNorm > 1) tNorm -= 1;

  if (tNorm < 1 / 6) return p + (q - p) * 6 * tNorm;
  if (tNorm < 1 / 2) return q;
  if (tNorm < 2 / 3) return p + (q - p) * (2 / 3 - tNorm) * 6;
  return p;
}

/**
 * Convert HSL to RGB color space.
 */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (Math.abs(s) < Number.EPSILON) {
    // Achromatic (gray)
    const v = Math.round(l * 255);
    return [v, v, v];
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hNorm = h / 360;

  return [
    Math.round(hueToRgb(p, q, hNorm + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, hNorm) * 255),
    Math.round(hueToRgb(p, q, hNorm - 1 / 3) * 255),
  ];
}

/**
 * Interpolate between two hex colors using HSL with shortest hue path.
 * Matches Rust backend's interpolate_hsl implementation.
 */
export function interpolateHsl(color1: string, color2: string, t: number): string {
  const rgb1 = hexToRgb(color1);
  const rgb2 = hexToRgb(color2);

  const [h1, s1, l1] = rgbToHsl(rgb1.r, rgb1.g, rgb1.b);
  const [h2, s2, l2] = rgbToHsl(rgb2.r, rgb2.g, rgb2.b);

  // Shortest hue path interpolation
  let dh = h2 - h1;
  if (dh > 180) {
    dh -= 360;
  } else if (dh < -180) {
    dh += 360;
  }

  // Use modulo to keep hue in valid range
  const h = ((h1 + dh * t) % 360 + 360) % 360;
  const s = s1 + (s2 - s1) * t;
  const l = l1 + (l2 - l1) * t;

  const [r, g, b] = hslToRgb(h, s, l);
  return rgbToHex(r, g, b);
}

/**
 * Multi-stop color interpolation matching Rust backend.
 * CRITICAL: Same safety guards as Rust implementation.
 */
export function interpolateStops(t: number, stops: ColorStop[]): string {
  // Guard for empty array
  if (stops.length === 0) {
    return '#000000';
  }
  // Guard for single stop
  const firstStop = stops[0];
  if (stops.length === 1 || !firstStop) {
    return firstStop?.color ?? '#000000';
  }

  // Clamp t to valid range
  const clampedT = Math.max(0, Math.min(1, t));

  // Find bracketing stops
  for (let i = 0; i < stops.length - 1; i++) {
    const currentStop = stops[i];
    const nextStop = stops[i + 1];
    if (!currentStop || !nextStop) continue;

    if (clampedT >= currentStop.position && clampedT <= nextStop.position) {
      const denominator = nextStop.position - currentStop.position;
      // Handle equal positions (avoid divide by zero)
      if (Math.abs(denominator) < Number.EPSILON) {
        return currentStop.color;
      }
      // Clamp localT to [0, 1] to match Rust backend and avoid float edge cases
      const rawLocalT = (clampedT - currentStop.position) / denominator;
      const localT = Math.max(0, Math.min(1, rawLocalT));
      return interpolateHsl(currentStop.color, nextStop.color, localT);
    }
  }

  // Fallback to last stop
  const lastStop = stops[stops.length - 1];
  return lastStop?.color ?? '#000000';
}

/**
 * Get depth color for a given depth value using preset color stops.
 */
export function getDepthColor(depth: number, minDepth: number, maxDepth: number, stops: ColorStop[]): string {
  const firstColor = stops[0]?.color ?? '#000000';
  // Handle NaN/infinite values
  if (!Number.isFinite(depth) || !Number.isFinite(minDepth) || !Number.isFinite(maxDepth)) {
    return firstColor;
  }
  // Handle flat depth range
  if (Math.abs(maxDepth - minDepth) < Number.EPSILON) {
    return firstColor;
  }
  // Normalize and clamp
  const t = Math.max(0, Math.min(1, (depth - minDepth) / (maxDepth - minDepth)));
  return interpolateStops(t, stops);
}

/**
 * Compute station color based on color mode.
 * Pure function - easy to unit test.
 */
export function computeStationColor(
  station: { coordinates: { z: number }; is_zero_datum: boolean },
  sectionColor: string,
  colorMode: 'section' | 'depth',
  depthRange: DepthRange,
  presetStops: ColorStop[] | null,
): string {
  // Zero datum always gold
  if (station.is_zero_datum) {
    return '#ffd700';
  }

  // Section mode or no preset
  if (colorMode === 'section' || !presetStops || presetStops.length === 0) {
    return sectionColor;
  }

  // Depth mode with multi-stop interpolation
  return getDepthColor(
    station.coordinates.z,
    depthRange.min,
    depthRange.max,
    presetStops,
  );
}

/**
 * Compute shot color based on color mode (uses average depth).
 */
export function computeShotColor(
  fromZ: number,
  toZ: number,
  sectionColor: string,
  colorMode: 'section' | 'depth',
  depthRange: DepthRange,
  presetStops: ColorStop[] | null,
): string {
  if (colorMode === 'section' || !presetStops || presetStops.length === 0) {
    return sectionColor;
  }

  const avgDepth = (fromZ + toZ) / 2;
  return getDepthColor(avgDepth, depthRange.min, depthRange.max, presetStops);
}

/**
 * Calculate depth range from stations.
 *
 * NOTE: This filters out non-finite z values for robustness (preview still shows gradient for valid stations).
 * The Rust backend does NOT filter, so if any z is ±Infinity, the backend's range becomes non-finite and
 * get_depth_color() returns first stop for all stations. This means preview can diverge from export in
 * corrupted-data scenarios. This is an intentional tradeoff: preview remains useful even with bad data.
 */
export function calculateDepthRange(stations: Array<{ coordinates: { z: number } }>): DepthRange {
  if (stations.length === 0) {
    return { min: 0, max: 50 };
  }

  let min = Infinity;
  let max = -Infinity;

  for (const station of stations) {
    const z = station.coordinates.z;
    if (Number.isFinite(z)) {
      min = Math.min(min, z);
      max = Math.max(max, z);
    }
  }

  // Handle case where no valid depths found
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 50 };
  }

  return { min, max };
}

/** Maximum allowed decimal precision to match Rust backend's MAX_DECIMAL_PRECISION */
const MAX_DECIMAL_PRECISION = 6;

/**
 * Format depth value with unit conversion and precision.
 * Clamps precision to [0, MAX_DECIMAL_PRECISION] to match Rust backend and prevent toFixed() RangeError.
 */
export function formatDepth(depth: number, unit: string, precision: number): string {
  // Clamp precision to valid range to prevent toFixed() RangeError and match Rust backend
  const clampedPrecision = Math.max(0, Math.min(MAX_DECIMAL_PRECISION, Math.floor(precision) || 0));
  const value = unit === 'ft' ? depth * 3.28084 : depth;
  return `${value.toFixed(clampedPrecision)}${unit}`;
}
