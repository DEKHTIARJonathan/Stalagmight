/**
 * Pick a readable foreground (black/white) for a given background color using
 * WCAG relative luminance. Used by entity blobs so the id text stays legible on
 * any preset/override color.
 */

/** Near-black ink used on light backgrounds (matches the icon spec's panel ink). */
const DARK_INK = '#16181c';
const LIGHT_INK = '#ffffff';

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance (0..1) of a #rgb / #rrggbb color; 0 for invalid input. */
export function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  let h = m[1]!;
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/**
 * Return '#16181c' (dark) for light backgrounds and '#ffffff' for dark ones.
 * Threshold 0.4 biases slightly toward dark ink, which reads better on the
 * mid-saturation entity colors. Invalid colors fall back to dark ink.
 */
export function readableTextColor(hex: string): string {
  return relativeLuminance(hex) > 0.4 ? DARK_INK : LIGHT_INK;
}
