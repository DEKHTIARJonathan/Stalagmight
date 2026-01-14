/**
 * Parse a hex color to RGB values
 */
export function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) {
    return [0, 0, 0];
  }
  return [
    parseInt(result[1] ?? '0', 16),
    parseInt(result[2] ?? '0', 16),
    parseInt(result[3] ?? '0', 16),
  ];
}

/**
 * Convert RGB values to hex color
 */
export function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((x) => {
        const hex = Math.round(x).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
      })
      .join('')
  );
}

/**
 * Interpolate between two colors based on a value between 0 and 1
 */
export function interpolateColor(
  color1: string,
  color2: string,
  t: number
): string {
  const [r1, g1, b1] = hexToRgb(color1);
  const [r2, g2, b2] = hexToRgb(color2);

  const r = r1 + (r2 - r1) * t;
  const g = g1 + (g2 - g1) * t;
  const b = b1 + (b2 - b1) * t;

  return rgbToHex(r, g, b);
}

/**
 * Get a color for a depth value using gradient settings
 */
export function getDepthColor(
  depth: number,
  shallowColor: string,
  deepColor: string,
  shallowDepth: number,
  deepDepth: number
): string {
  if (depth <= shallowDepth) {
    return shallowColor;
  }
  if (depth >= deepDepth) {
    return deepColor;
  }

  const t = (depth - shallowDepth) / (deepDepth - shallowDepth);
  return interpolateColor(shallowColor, deepColor, t);
}

/**
 * Convert hex color to rgba string with alpha
 */
export function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Lighten a color by a percentage (0-100)
 */
export function lightenColor(hex: string, percent: number): string {
  const [r, g, b] = hexToRgb(hex);
  const factor = percent / 100;

  return rgbToHex(
    r + (255 - r) * factor,
    g + (255 - g) * factor,
    b + (255 - b) * factor
  );
}

/**
 * Darken a color by a percentage (0-100)
 */
export function darkenColor(hex: string, percent: number): string {
  const [r, g, b] = hexToRgb(hex);
  const factor = 1 - percent / 100;

  return rgbToHex(r * factor, g * factor, b * factor);
}

/**
 * Check if a color is light (for choosing contrast text color)
 */
export function isLightColor(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex);
  // Using perceived luminance formula
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5;
}

/**
 * Get a contrasting text color for a background
 */
export function getContrastColor(backgroundColor: string): string {
  return isLightColor(backgroundColor) ? '#000000' : '#ffffff';
}

/**
 * Default section color palette
 */
export const SECTION_COLORS = [
  '#4ecdc4', // Teal
  '#ff6b6b', // Coral
  '#95e1d3', // Mint
  '#f38181', // Salmon
  '#aa96da', // Lavender
  '#fcbad3', // Pink
  '#a8d8ea', // Sky Blue
  '#ffcb77', // Peach
];

/**
 * Get the next available color from the palette
 */
export function getNextSectionColor(usedColors: string[]): string {
  for (const color of SECTION_COLORS) {
    if (!usedColors.includes(color)) {
      return color;
    }
  }
  // If all colors used, return the first one
  return SECTION_COLORS[0] ?? '#4ecdc4';
}
