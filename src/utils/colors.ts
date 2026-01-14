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
 * Generate a random color with good saturation and lightness
 * that is visually distinct from existing colors
 */
function generateRandomColor(usedColors: string[]): string {
  // Generate random hue, avoiding hues too similar to existing colors
  const usedHues = usedColors.map((c) => {
    const [r, g, b] = hexToRgb(c);
    // Convert RGB to HSL to get hue
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    let h = 0;
    if (max === r) {
      h = (g - b) / (max - min);
    } else if (max === g) {
      h = 2 + (b - r) / (max - min);
    } else {
      h = 4 + (r - g) / (max - min);
    }
    h *= 60;
    if (h < 0) h += 360;
    return h;
  });

  // Find a hue that's at least 30 degrees away from all used hues
  let bestHue = Math.random() * 360;
  let bestMinDistance = 0;

  for (let attempt = 0; attempt < 20; attempt++) {
    const candidateHue = Math.random() * 360;
    const minDistance = Math.min(
      ...usedHues.map((h) => {
        const diff = Math.abs(candidateHue - h);
        return Math.min(diff, 360 - diff);
      }),
      360 // Default if no used hues
    );
    if (minDistance > bestMinDistance) {
      bestMinDistance = minDistance;
      bestHue = candidateHue;
    }
  }

  // Convert HSL to RGB with good saturation (60-80%) and lightness (50-60%)
  const h = bestHue;
  const s = 0.6 + Math.random() * 0.2; // 60-80% saturation
  const l = 0.5 + Math.random() * 0.1; // 50-60% lightness

  // HSL to RGB conversion
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) {
    [r, g, b] = [c, x, 0];
  } else if (h < 120) {
    [r, g, b] = [x, c, 0];
  } else if (h < 180) {
    [r, g, b] = [0, c, x];
  } else if (h < 240) {
    [r, g, b] = [0, x, c];
  } else if (h < 300) {
    [r, g, b] = [x, 0, c];
  } else {
    [r, g, b] = [c, 0, x];
  }

  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/**
 * Get the next available color from the palette
 */
export function getNextSectionColor(usedColors: string[]): string {
  for (const color of SECTION_COLORS) {
    if (!usedColors.includes(color)) {
      return color;
    }
  }
  // If all palette colors used, generate a random distinct color
  return generateRandomColor(usedColors);
}
