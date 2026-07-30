import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapVizTokenNames, themeTokens } from '../tokens';
import { getDepthColor } from '../../utils/colors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cssPath = path.resolve(__dirname, '../../index.css');
const cssSource = fs.readFileSync(cssPath, 'utf8');
const htmlPath = path.resolve(__dirname, '../../../index.html');
const htmlSource = fs.readFileSync(htmlPath, 'utf8');
/** index.html with comments stripped, so prose cannot satisfy a rule below. */
const htmlRules = htmlSource.replace(/\/\*[\s\S]*?\*\//g, '');

function extractBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Missing theme block for marker: ${marker}`);
  }
  const open = source.indexOf('{', start);
  if (open === -1) {
    throw new Error(`Missing opening brace for marker: ${marker}`);
  }
  const close = source.indexOf('}', open);
  if (close === -1) {
    throw new Error(`Missing closing brace for marker: ${marker}`);
  }
  return source.slice(open + 1, close);
}

function extractTokens(block: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  const tokenRegex = /(--cc-[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match: RegExpExecArray | null = null;
  while ((match = tokenRegex.exec(block)) !== null) {
    const name = match[1];
    const value = match[2];
    if (!name || !value) continue;
    tokens[name] = value.trim();
  }
  return tokens;
}

function sortedKeys(tokens: Record<string, string>): string[] {
  return Object.keys(tokens).sort();
}

const cssDarkTokens = extractTokens(extractBlock(cssSource, ':root,'));
const cssLightTokens = extractTokens(extractBlock(cssSource, '[data-theme="light"]'));
const cssCaveTokens = extractTokens(extractBlock(cssSource, '[data-theme="cave"]'));
const cssDraculaTokens = extractTokens(extractBlock(cssSource, '[data-theme="dracula"]'));
const cssOneDarkTokens = extractTokens(extractBlock(cssSource, '[data-theme="one_dark"]'));
const cssSolarizedLightTokens = extractTokens(extractBlock(cssSource, '[data-theme="solarized_light"]'));
const cssCatppuccinLatteTokens = extractTokens(extractBlock(cssSource, '[data-theme="catppuccin_latte"]'));
const cssNordTokens = extractTokens(extractBlock(cssSource, '[data-theme="nord"]'));
const cssCatppuccinMochaTokens = extractTokens(extractBlock(cssSource, '[data-theme="catppuccin_mocha"]'));
const cssKaleidoEinkTokens = extractTokens(extractBlock(cssSource, '[data-theme="kaleido_eink"]'));

/** Dark themes must include all dark token keys (including map visualization). */
const FULL_DARK_THEMES = ['cave', 'dracula', 'one_dark', 'nord', 'catppuccin_mocha'] as const;

/** Light themes only override UI chrome + controls (no map viz tokens). */
const LIGHT_THEMES = ['solarized_light', 'catppuccin_latte'] as const;

/** Light themes with full token sets (including map visualization overrides). */
const FULL_LIGHT_THEMES = ['kaleido_eink', 'light'] as const;

const cssTokensByTheme: Record<string, Record<string, string>> = {
  dark: cssDarkTokens,
  light: cssLightTokens,
  cave: cssCaveTokens,
  dracula: cssDraculaTokens,
  one_dark: cssOneDarkTokens,
  solarized_light: cssSolarizedLightTokens,
  catppuccin_latte: cssCatppuccinLatteTokens,
  nord: cssNordTokens,
  catppuccin_mocha: cssCatppuccinMochaTokens,
  kaleido_eink: cssKaleidoEinkTokens,
};

describe('theme tokens', () => {
  it('dark tokens match CSS :root block', () => {
    expect(sortedKeys(cssDarkTokens)).toEqual(sortedKeys(themeTokens.dark));
    for (const [key, value] of Object.entries(themeTokens.dark)) {
      expect(cssDarkTokens[key]).toBe(value);
    }
  });

  it('light tokens match CSS light block', () => {
    expect(sortedKeys(cssLightTokens)).toEqual(sortedKeys(themeTokens.light));
    for (const [key, value] of Object.entries(themeTokens.light)) {
      expect(cssLightTokens[key]).toBe(value);
    }
  });

  it('cave tokens match CSS cave block', () => {
    expect(sortedKeys(cssCaveTokens)).toEqual(sortedKeys(themeTokens.cave));
    for (const [key, value] of Object.entries(themeTokens.cave)) {
      expect(cssCaveTokens[key]).toBe(value);
    }
  });

  it.each(FULL_DARK_THEMES)('%s tokens include all dark token keys (full dark theme)', (theme) => {
    expect(sortedKeys(themeTokens[theme])).toEqual(sortedKeys(themeTokens.dark));
  });

  it.each(FULL_DARK_THEMES)('%s tokens match CSS block', (theme) => {
    const cssTokens = cssTokensByTheme[theme]!;
    expect(sortedKeys(cssTokens)).toEqual(sortedKeys(themeTokens[theme]));
    for (const [key, value] of Object.entries(themeTokens[theme])) {
      expect(cssTokens[key]).toBe(value);
    }
  });

  it.each(LIGHT_THEMES)('%s tokens only override UI chrome and controls', (theme) => {
    const themeKeys = new Set(Object.keys(themeTokens[theme]));
    const missingKeys = Object.keys(themeTokens.dark).filter((key) => !themeKeys.has(key));

    expect(missingKeys.sort()).toEqual([...mapVizTokenNames].sort());

    const cssTokens = cssTokensByTheme[theme]!;
    for (const key of mapVizTokenNames) {
      expect(themeKeys.has(key)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(cssTokens, key)).toBe(false);
    }
  });

  it.each(LIGHT_THEMES)('%s tokens match CSS block', (theme) => {
    const cssTokens = cssTokensByTheme[theme]!;
    expect(sortedKeys(cssTokens)).toEqual(sortedKeys(themeTokens[theme]));
    for (const [key, value] of Object.entries(themeTokens[theme])) {
      expect(cssTokens[key]).toBe(value);
    }
  });

  it.each(FULL_LIGHT_THEMES)('%s tokens include all dark token keys (full light theme)', (theme) => {
    expect(sortedKeys(themeTokens[theme])).toEqual(sortedKeys(themeTokens.dark));
  });

  it.each(FULL_LIGHT_THEMES)('%s tokens match CSS block', (theme) => {
    const cssTokens = cssTokensByTheme[theme]!;
    expect(sortedKeys(cssTokens)).toEqual(sortedKeys(themeTokens[theme]));
    for (const [key, value] of Object.entries(themeTokens[theme])) {
      expect(cssTokens[key]).toBe(value);
    }
  });
});

/**
 * The depth gradient is the one map colour a theme can get wrong without any token
 * being missing: `getDepthColor` interpolates between the two endpoints along the
 * SHORTEST HSL hue path, so a pair that looks fine at both ends can pass through a
 * near-invisible hue in the middle. The dark theme's teal -> coral does exactly that
 * on a light canvas, bottoming out at 1.14:1. Assert the whole ramp, against each
 * theme's own canvas, using the production interpolation rather than a copy of it.
 */
describe('depth gradient legibility', () => {
  /** WCAG relative luminance. */
  function luminance(hex: string): number {
    const channel = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  }

  function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  }

  /** Worst contrast anywhere along the drawn ramp, plus where it occurs. */
  /** Themes that declare their own map-visualization tokens. */
  type FullTheme =
    | (typeof FULL_LIGHT_THEMES)[number]
    | (typeof FULL_DARK_THEMES)[number]
    | 'dark';

  function worstOnRamp(theme: FullTheme) {
    const tokens = themeTokens[theme];
    const canvas = tokens['--cc-map-background'];
    const shallow = tokens['--cc-depth-shallow'];
    const deep = tokens['--cc-depth-deep'];
    let worst = Number.POSITIVE_INFINITY;
    let at = '';
    for (let i = 0; i <= 40; i++) {
      // Depths are negative elevations, so minDepth is the DEEPER end. Passing them
      // the other way round makes getDepthColor's own clamp degenerate (min > max)
      // and the sweep only ever returns the two endpoints - which silently turns
      // this into an endpoint check and misses the mid-ramp hue entirely.
      const color = getDepthColor(-40 + i, shallow, deep, -40, 0);
      expect(color).not.toBeNull();
      const ratio = contrast(color!, canvas);
      if (ratio < worst) {
        worst = ratio;
        at = color!;
      }
    }
    return { worst, at, canvas };
  }

  // 3:1 is the WCAG floor for non-text graphical objects, which is what a survey line
  // is. Full themes only: the chrome-only light themes inherit the dark canvas, so
  // their ramp is judged against that one.
  const RAMP_FLOOR = 3;

  /**
   * Themes already below the floor when this guard was added, with the value measured
   * at the time. Pre-existing and out of scope for #332 (which is about the light
   * canvas), but recorded so they cannot quietly get worse. `one_dark` interpolates
   * indigo -> indigo through a mid-blue that sits close to its own dark canvas.
   */
  const KNOWN_BELOW_FLOOR: Partial<Record<FullTheme, number>> = { one_dark: 2.59 };

  it.each([...FULL_LIGHT_THEMES, ...FULL_DARK_THEMES, 'dark' as const])(
    '%s keeps the whole depth ramp at 3:1 or better against its own canvas',
    (theme) => {
      const { worst, at, canvas } = worstOnRamp(theme);
      const known = KNOWN_BELOW_FLOOR[theme];
      if (known === undefined) {
        expect(
          worst,
          `${theme}: ${at} on ${canvas} is ${worst.toFixed(2)}:1, below the ${RAMP_FLOOR}:1 floor`
        ).toBeGreaterThanOrEqual(RAMP_FLOOR);
        return;
      }
      // Not allowed to get worse...
      expect(
        worst,
        `${theme} regressed: ${at} on ${canvas} is now ${worst.toFixed(2)}:1, was ${known}:1`
      ).toBeGreaterThanOrEqual(known);
      // ...and once it clears the floor, this entry is stale - delete it.
      expect(
        worst,
        `${theme} now clears ${RAMP_FLOOR}:1 (${worst.toFixed(2)}:1) - remove it from KNOWN_BELOW_FLOOR`
      ).toBeLessThan(RAMP_FLOOR);
    }
  );

  it('would reject the dark endpoints on the light canvas', () => {
    // Proves the test above can fail: this is the exact pairing light shipped with
    // before the endpoints were themed.
    const light = themeTokens.light['--cc-map-background'];
    let worst = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= 40; i++) {
      const color = getDepthColor(
        -40 + i,
        themeTokens.dark['--cc-depth-shallow'],
        themeTokens.dark['--cc-depth-deep'],
        -40,
        0
      );
      worst = Math.min(worst, contrast(color!, light));
    }
    expect(worst).toBeLessThan(2);
  });
});

/**
 * index.html paints the frame before the CSS bundle loads. Nothing else in the
 * repo reads that file, so these are the only guards on it: #332 was caused by a
 * hard-coded background there, and the first fix for it reintroduced a different
 * hard-coded guess (an OS colour-scheme media query, which disagrees with the
 * shipped default of theme "dark").
 */
describe('index.html anti-flash cover', () => {
  it('uses the same hex as :root --cc-background', () => {
    const cover = /html\s*\{\s*background-color:\s*(#[0-9a-f]{3,8})\s*;/i.exec(
      htmlRules
    );
    expect(cover).not.toBeNull();
    expect(cover![1]!.toLowerCase()).toBe(
      themeTokens.dark['--cc-background'].toLowerCase()
    );
  });

  it('hands over to the live token once data-theme is stamped', () => {
    expect(htmlRules).toMatch(
      /html\[data-theme\]\s*\{\s*background-color:\s*var\(\s*--cc-background\s*\)\s*;/
    );
  });

  it('does not pin the background with an inline style on body (#332)', () => {
    const bodyTag = /<body[^>]*>/i.exec(htmlRules);
    expect(bodyTag).not.toBeNull();
    expect(bodyTag![0]).not.toMatch(/style\s*=/i);
  });

  it('does not guess the theme from the OS colour scheme', () => {
    // The OS preference is only consulted when appearance.theme is "auto"
    // (src/hooks/useTheme.ts), so keying the cover off it repaints the shipped
    // default the wrong colour on a light-appearance machine.
    expect(htmlRules).not.toMatch(/@media[^{]*prefers-color-scheme/i);
  });
});
