import { describe, it, expect } from 'vitest';
import { themeTokens } from '../tokens';
import { getDepthColor, hexToHSL, hexToRgb } from '../../utils/colors';

/**
 * The endpoint-contrast test in tokens.test.ts (worstOnRamp / RAMP_FLOOR) checks
 * each ramp against its own canvas, but never checks the two ENDPOINTS against
 * EACH OTHER. That gap is exactly what let `cave` ship: #a89060 (tan, hue ~40) to
 * #b85048 (salmon, hue ~4) both clear 3:1 against the cave canvas individually,
 * so an entire survey rendered as one near-uniform salmon in Depth mode without
 * tripping anything (see the bug screenshot referenced in #357/#345). This file
 * is the guard that would have caught it: four independent, theme-agnostic
 * properties, each sweeping the PRODUCTION `getDepthColor` (never re-deriving the
 * interpolation math) so a change to the interpolation itself is exercised too.
 *
 * All four properties are measured in CIE Lab / CIEDE2000, not hex-string or raw
 * RGB distance, because HSL hue distance alone is exactly the metric that missed
 * `cave` (~35 degrees of hue read as "barely different" by eye but not by naive
 * numeric hue delta either - Lab is what actually models perceived difference).
 */

const N_SAMPLES = 41; // t = i/40 for i in 0..40, matching tokens.test.ts's worstOnRamp sweep

function sampleRamp(shallowColor: string, deepColor: string, n = N_SAMPLES): string[] {
  const colors: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const color = getDepthColor(t, shallowColor, deepColor, 0, 1);
    expect(color, `getDepthColor returned null for t=${t}`).not.toBeNull();
    colors.push(color!);
  }
  return colors;
}

// ---------------------------------------------------------------------------
// CIE Lab conversion (sRGB, D65 white point). Matrix per the standard sRGB
// working-space definition (IEC 61966-2-1 / Bruce Lindbloom's published sRGB
// D65 RGB-to-XYZ matrix); Lab formulas per CIE 15:2004.
// ---------------------------------------------------------------------------

function srgbChannelToLinear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgbChannel(c: number): number {
  const clamped = Math.min(Math.max(c, 0), 1);
  const v = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

type Xyz = [number, number, number];
type Lab = [number, number, number];

function hexToXyz(hex: string): Xyz {
  const [r8, g8, b8] = hexToRgb(hex);
  const r = srgbChannelToLinear(r8);
  const g = srgbChannelToLinear(g8);
  const b = srgbChannelToLinear(b8);
  return [
    r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    r * 0.2126729 + g * 0.7151522 + b * 0.072175,
    r * 0.0193339 + g * 0.119192 + b * 0.9503041,
  ];
}

const D65_XN = 0.95047;
const D65_YN = 1.0;
const D65_ZN = 1.08883;

function xyzToLab([x, y, z]: Xyz): Lab {
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / D65_XN);
  const fy = f(y / D65_YN);
  const fz = f(z / D65_ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function hexToLab(hex: string): Lab {
  return xyzToLab(hexToXyz(hex));
}

function deg2rad(d: number): number {
  return (d * Math.PI) / 180;
}

/**
 * CIEDE2000 colour difference. Formula per Sharma, Wu & Dalal (2005), "The
 * CIEDE2000 Color-Difference Formula: Implementation Notes, Supplementary Test
 * Data, and Mathematical Observations", Color Research & Application 30(1).
 * kL=kC=kH=1 (the default "graphic arts" weighting).
 */
function deltaE2000(lab1: Lab, lab2: Lab): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const cBar = (C1 + C2) / 2;
  const g = 0.5 * (1 - Math.sqrt(Math.pow(cBar, 7) / (Math.pow(cBar, 7) + Math.pow(25, 7))));
  const a1p = a1 * (1 + g);
  const a2p = a2 * (1 + g);
  const c1p = Math.sqrt(a1p * a1p + b1 * b1);
  const c2p = Math.sqrt(a2p * a2p + b2 * b2);
  const h1p = ((Math.atan2(b1, a1p) * 180) / Math.PI + 360) % 360;
  const h2p = ((Math.atan2(b2, a2p) * 180) / Math.PI + 360) % 360;

  const dLp = L2 - L1;
  const dCp = c2p - c1p;
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(deg2rad(dhp) / 2);

  const lBarp = (L1 + L2) / 2;
  const cBarp = (c1p + c2p) / 2;
  let hBarp: number;
  if (c1p * c2p === 0) hBarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hBarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hBarp = (h1p + h2p + 360) / 2;
  else hBarp = (h1p + h2p - 360) / 2;

  const t =
    1 -
    0.17 * Math.cos(deg2rad(hBarp - 30)) +
    0.24 * Math.cos(deg2rad(2 * hBarp)) +
    0.32 * Math.cos(deg2rad(3 * hBarp + 6)) -
    0.2 * Math.cos(deg2rad(4 * hBarp - 63));

  const dTheta = 30 * Math.exp(-Math.pow((hBarp - 275) / 25, 2));
  const rc = 2 * Math.sqrt(Math.pow(cBarp, 7) / (Math.pow(cBarp, 7) + Math.pow(25, 7)));
  const sl = 1 + (0.015 * Math.pow(lBarp - 50, 2)) / Math.sqrt(20 + Math.pow(lBarp - 50, 2));
  const sc = 1 + 0.045 * cBarp;
  const sh = 1 + 0.015 * cBarp * t;
  const rt = -Math.sin(deg2rad(2 * dTheta)) * rc;

  return Math.sqrt(
    Math.pow(dLp / sl, 2) + Math.pow(dCp / sc, 2) + Math.pow(dHp / sh, 2) + rt * (dCp / sc) * (dHp / sh)
  );
}

function deltaE2000Hex(hexA: string, hexB: string): number {
  return deltaE2000(hexToLab(hexA), hexToLab(hexB));
}

// ---------------------------------------------------------------------------
// Colourblindness simulation. Matrices per Machado, Oliveira & Fernandes
// (2009), "A Physiologically-based Model for Simulation of Color Vision
// Deficiency", IEEE Transactions on Visualization and Computer Graphics 15(6) -
// the 100%-severity (complete dichromacy) protanopia/deuteranopia matrices,
// applied directly to linearized sRGB.
// ---------------------------------------------------------------------------

type Mat3 = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];

const PROTANOPIA_MATRIX: Mat3 = [
  [0.152286, 1.052583, -0.204868],
  [0.114503, 0.786281, 0.099216],
  [-0.003882, -0.048116, 1.051998],
];

const DEUTERANOPIA_MATRIX: Mat3 = [
  [0.367322, 0.860646, -0.227968],
  [0.280085, 0.672501, 0.047413],
  [-0.01182, 0.04294, 0.968881],
];

function simulateCvd(hex: string, matrix: Mat3): string {
  const [r8, g8, b8] = hexToRgb(hex);
  const r = srgbChannelToLinear(r8);
  const g = srgbChannelToLinear(g8);
  const b = srgbChannelToLinear(b8);
  const [ro, go, bo] = matrix.map(([m0, m1, m2]) => m0 * r + m1 * g + m2 * b);
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(linearToSrgbChannel(ro!))}${toHex(linearToSrgbChannel(go!))}${toHex(linearToSrgbChannel(bo!))}`;
}

// ---------------------------------------------------------------------------
// The four assertion helpers. Each takes a shallow/deep hex pair (never a
// theme name) so the exact same function runs over real theme tokens AND over
// hand-built fixtures in the "proof" tests below.
// ---------------------------------------------------------------------------

/** Property 1: perceptual distance between the ramp's two ends. */
function endpointDiscriminability(shallowColor: string, deepColor: string): number {
  const shallow = getDepthColor(0, shallowColor, deepColor, 0, 1)!;
  const deep = getDepthColor(1, shallowColor, deepColor, 0, 1)!;
  return deltaE2000Hex(shallow, deep);
}

/**
 * Property 2: stepping from shallow to deep must move consistently in one
 * perceptual direction. Measured as CIEDE2000 distance from the shallow
 * endpoint at each sample - a ramp that loops back would show that distance
 * decrease partway through, meaning two different depths render the same (or
 * a very similar) colour. `EPS` absorbs 8-bit hex quantization noise, not real
 * regressions - the real `getDepthColor` violation frozen in the proof block
 * below dips by 7.31, i.e. 146x this value.
 */
const MONOTONICITY_EPS = 0.05;

function monotonicityViolations(shallowColor: string, deepColor: string): number {
  const colors = sampleRamp(shallowColor, deepColor);
  const startLab = hexToLab(colors[0]!);
  let prevDist = -Infinity;
  let violations = 0;
  for (const color of colors) {
    const dist = deltaE2000(startLab, hexToLab(color));
    if (dist < prevDist - MONOTONICITY_EPS) violations++;
    prevDist = Math.max(prevDist, dist);
  }
  return violations;
}

/**
 * Property 3: `getDepthColor` walks the shortest HSL hue path (tokens.ts:440).
 * Green (~120) to red (~0) correctly falls through yellow/orange (~30-90); any
 * shallow hue >= ~180 relative to a reddish deep flips the shortest path
 * through cyan/blue/violet/magenta instead (the exact bug that made one_dark's
 * pre-fix ramp bottom out at 2.60:1, per the tokens.ts:440 comment).
 *
 * The band starts at 179 rather than 170 so that a CYAN shallow endpoint is not
 * penalised for the single sample at its own start. 180 is the real dividing
 * line - below it the path descends through green and yellow, at or above it the
 * path inverts - so 179 is as tight as this can be without rejecting the shipped
 * ramp, whose shallow anchors run 169.8-174.9. A ramp that genuinely inverts
 * still gets caught: starting above 180 sends the sweep up through 240-300,
 * which is deep inside the band. Returns the deepest incursion in degrees
 * (0 = the ramp never enters the band).
 */
const FORBIDDEN_HUE_MIN = 179;
const FORBIDDEN_HUE_MAX = 330;

function maxHueIncursion(shallowColor: string, deepColor: string): number {
  const colors = sampleRamp(shallowColor, deepColor);
  let worst = 0;
  for (const color of colors) {
    const hsl = hexToHSL(color);
    if (!hsl) continue;
    const { h } = hsl;
    if (h > FORBIDDEN_HUE_MIN && h < FORBIDDEN_HUE_MAX) {
      const incursion = Math.min(h - FORBIDDEN_HUE_MIN, FORBIDDEN_HUE_MAX - h);
      if (incursion > worst) worst = incursion;
    }
  }
  return worst;
}

/** Property 4: endpoint discriminability re-measured after CVD simulation. */
function cvdSafetyDeltas(shallowColor: string, deepColor: string): { protanopia: number; deuteranopia: number } {
  const shallow = getDepthColor(0, shallowColor, deepColor, 0, 1)!;
  const deep = getDepthColor(1, shallowColor, deepColor, 0, 1)!;
  return {
    protanopia: deltaE2000Hex(simulateCvd(shallow, PROTANOPIA_MATRIX), simulateCvd(deep, PROTANOPIA_MATRIX)),
    deuteranopia: deltaE2000Hex(simulateCvd(shallow, DEUTERANOPIA_MATRIX), simulateCvd(deep, DEUTERANOPIA_MATRIX)),
  };
}

// ---------------------------------------------------------------------------
// The two perceptual floors. Declared at module scope, NOT inside the describe
// block that asserts them, so the "proof: the harness catches real regressions"
// tests below can compare against the live constant instead of re-typing its
// value. A proof that hard-codes `40` stops proving anything about the guard
// the moment the guard moves - the same defect already fixed once on this
// branch, where a staleness check compared against a hard-coded floor instead
// of the per-theme one (tokens.test.ts, KNOWN_BELOW_FLOOR).
// ---------------------------------------------------------------------------

/**
 * Property 1 floor. Justification: cave's pre-retune ramp (#a89060 -> #b85048,
 * frozen and re-checked in the "proof" describe block below) scores 29.22 -
 * well inside the CIEDE2000 "colours read as more similar than opposite" band
 * (roughly 11-49 on the common interpretive scale; 100 is exact opposites). A
 * green/red pair meant to read as genuinely different (#3fa34d -> #d64545, the
 * example in the task) scores 67.25, solidly past 50 ("more different than
 * similar"). 40 sits between the two with margin on both sides and below every
 * currently-shipped ramp (62.28-70.06, measured 2026-07-30 over the eight
 * themes in EXPECTED_DEPTH_RAMP_THEMES; re-measure before quoting this range).
 */
const DISCRIMINABILITY_FLOOR = 40;

/**
 * Property 4 floor. Justification: pre-retune cave's deuteranopia-simulated
 * endpoints scored 10.37 deltaE2000 - deuteranopia (~5% of men) is the single
 * most common red-green deficiency, and 10.37 sits in "perceptible at a glance
 * at best" territory. The iso-luminant green/red fixture in the proof block
 * below scores 5.99. Protanopia clears comfortably for every theme today
 * (37.91-47.41, measured 2026-07-30); deuteranopia is the tighter channel at
 * 34.21-40.87. 15 sits below both shipped ranges while still catching the
 * 10.37 and 5.99 failures, so it is not a floor reverse-engineered to pass
 * everything.
 */
const CVD_SAFETY_FLOOR = 15;

// ---------------------------------------------------------------------------
// Theme set: derived from whatever tokens are current, not hardcoded, so a
// theme added/removed/retuned by the parallel tokens.ts work is picked up
// automatically. Only themes that declare their own depth-ramp tokens are in
// scope (mirrors tokens.test.ts's FullTheme set); chrome-only light themes
// inherit `dark`'s ramp and are covered by testing `dark` itself.
//
// Derived sets are silently fragile in vitest 2.1.9: `.each` is implemented as
// `cases.forEach(...)`, so an EMPTY array registers ZERO tests and the file
// still reports green (unlike Jest, which throws on an empty `.each` table).
// Rename `--cc-depth-shallow` and all four properties below would vanish while
// the CSS/tokens sync tests kept passing, because those only compare the two
// sides to each other. EXPECTED_DEPTH_RAMP_THEMES + the non-vacuity test at the
// top of the describe block are what make that a failure instead.
// ---------------------------------------------------------------------------

type ThemeName = keyof typeof themeTokens;

const THEMES_WITH_DEPTH_RAMP = (Object.keys(themeTokens) as ThemeName[]).filter(
  (name) => '--cc-depth-shallow' in themeTokens[name] && '--cc-depth-deep' in themeTokens[name]
);

/**
 * The set `THEMES_WITH_DEPTH_RAMP` is expected to derive TODAY. Pinned in both
 * directions, exactly as tokens.test.ts pins its own derived light-canvas set:
 * a theme joining or leaving the depth-ramp set changes which themes get any
 * perceptual checking at all, and that is a decision, not a detail.
 */
const EXPECTED_DEPTH_RAMP_THEMES = [
  'cave',
  'catppuccin_mocha',
  'dark',
  'dracula',
  'kaleido_eink',
  'light',
  'nord',
  'one_dark',
] as const;

function rampOf(theme: ThemeName): { shallow: string; deep: string } {
  const tokens: Record<string, string> = themeTokens[theme];
  return { shallow: tokens['--cc-depth-shallow']!, deep: tokens['--cc-depth-deep']! };
}

describe('depth ramp legibility', () => {
  it('runs all four properties over a non-empty, pinned set of themes', () => {
    // The load-bearing assertion in this file. Every property below is an
    // `it.each(THEMES_WITH_DEPTH_RAMP)`, and vitest 2.1.9's `.each` is a plain
    // `forEach` over the cases: an empty table registers zero tests and the run
    // is still green. So the four properties can go from "eight themes checked"
    // to "nothing checked" with no failure anywhere - renaming
    // `--cc-depth-shallow` in tokens.ts and index.css together does exactly
    // that, and the CSS/tokens sync tests stay green because they only compare
    // the two sides to each other. Assert non-emptiness first (the vacuity
    // mode) and then the exact set (the coverage mode).
    expect(THEMES_WITH_DEPTH_RAMP.length, 'no theme declares a depth ramp - all four properties below are vacuous').toBeGreaterThan(0);
    expect(THEMES_WITH_DEPTH_RAMP.slice().sort()).toEqual([...EXPECTED_DEPTH_RAMP_THEMES].slice().sort());
  });

  describe('property 1: discriminability (shallow and deep must be perceptually far apart)', () => {
    /** Empty: every theme currently clears the floor. Keep the ratchet ready -
     * if a future retune drops a theme below 40, add it here with the
     * measured value so it can only get better, never silently worse. */
    const KNOWN_LOW_DISCRIMINABILITY: Partial<Record<ThemeName, number>> = {};

    it.each(THEMES_WITH_DEPTH_RAMP)('%s: shallow/deep endpoints clear the discriminability floor', (theme) => {
      const { shallow, deep } = rampOf(theme);
      const delta = endpointDiscriminability(shallow, deep);
      const known = KNOWN_LOW_DISCRIMINABILITY[theme];
      if (known === undefined) {
        expect(
          delta,
          `${theme}: ${shallow} -> ${deep} scores ${delta.toFixed(2)} deltaE2000, below the ${DISCRIMINABILITY_FLOOR} floor`
        ).toBeGreaterThanOrEqual(DISCRIMINABILITY_FLOOR);
        return;
      }
      expect(delta, `${theme} regressed: was ${known}, now ${delta.toFixed(3)}`).toBeGreaterThanOrEqual(known);
      expect(
        delta,
        `${theme} now clears the discriminability floor (${delta.toFixed(2)}) - remove it from KNOWN_LOW_DISCRIMINABILITY`
      ).toBeLessThan(DISCRIMINABILITY_FLOOR);
    });
  });

  describe('property 2: monotonicity (no looping back to an earlier colour)', () => {
    it.each(THEMES_WITH_DEPTH_RAMP)('%s: perceptual distance from the shallow endpoint never decreases', (theme) => {
      const { shallow, deep } = rampOf(theme);
      expect(
        monotonicityViolations(shallow, deep),
        `${theme}: ${shallow} -> ${deep} loops back toward its own shallow endpoint somewhere on the ramp`
      ).toBe(0);
    });
  });

  describe('property 3: no forbidden detour (must not flip onto the cyan/blue/violet arc)', () => {
    /** Empty: every theme currently stays off the forbidden arc. Before the
     * green->red retune landed, this caught six themes routing through
     * cyan/blue/violet (dark, light, dracula, nord, catppuccin_mocha,
     * kaleido_eink each measured 5.7-79.9 degrees of incursion) - see the
     * synthetic-fixture proof below for the mechanism. Keep the ratchet ready
     * for the next theme that regresses. */
    const KNOWN_HUE_DETOUR: Partial<Record<ThemeName, number>> = {};

    it.each(THEMES_WITH_DEPTH_RAMP)('%s: ramp midpoints stay off the forbidden hue arc', (theme) => {
      const { shallow, deep } = rampOf(theme);
      const incursion = maxHueIncursion(shallow, deep);
      const known = KNOWN_HUE_DETOUR[theme];
      if (known === undefined) {
        expect(
          incursion,
          `${theme}: ${shallow} -> ${deep} enters the forbidden ${FORBIDDEN_HUE_MIN}-${FORBIDDEN_HUE_MAX} hue arc (${incursion.toFixed(1)} deg deep)`
        ).toBe(0);
        return;
      }
      expect(incursion, `${theme} regressed: was ${known}, now ${incursion.toFixed(3)}`).toBeLessThanOrEqual(known);
      expect(
        incursion,
        `${theme} no longer detours (${incursion.toFixed(1)} deg) - remove it from KNOWN_HUE_DETOUR`
      ).toBeGreaterThan(0);
    });
  });

  describe('property 4: colourblind safety (deuteranopia/protanopia simulated discriminability)', () => {
    /**
     * A green->red hue swap alone is not colourblind-safe. `one_dark` (13.955),
     * `nord` (13.644) and `catppuccin_mocha` (12.406) were parked here when this
     * harness landed: they cleared property 1 (hue-only discriminability) and
     * property 3 (no hue detour) but failed deuteranopia simulation, because
     * their endpoints carried too little LIGHTNESS travel alongside the hue
     * change. All three were then retuned to spread their endpoints in lightness
     * and now clear the floor on their own, so the list is empty - which is what
     * the "remove it from KNOWN_UNSAFE" assertion below exists to force.
     */
    const KNOWN_UNSAFE: Partial<Record<ThemeName, { protanopia?: number; deuteranopia?: number }>> = {};

    it.each(THEMES_WITH_DEPTH_RAMP)('%s: stays discriminable under protanopia and deuteranopia simulation', (theme) => {
      const { shallow, deep } = rampOf(theme);
      const { protanopia, deuteranopia } = cvdSafetyDeltas(shallow, deep);
      const known = KNOWN_UNSAFE[theme];

      for (const [channel, delta] of [
        ['protanopia', protanopia],
        ['deuteranopia', deuteranopia],
      ] as const) {
        const knownForChannel = known?.[channel];
        if (knownForChannel === undefined) {
          expect(
            delta,
            `${theme}: ${channel}-simulated endpoints score ${delta.toFixed(2)}, below the ${CVD_SAFETY_FLOOR} floor`
          ).toBeGreaterThanOrEqual(CVD_SAFETY_FLOOR);
          continue;
        }
        expect(
          delta,
          `${theme} regressed under ${channel}: was ${knownForChannel}, now ${delta.toFixed(3)}`
        ).toBeGreaterThanOrEqual(knownForChannel);
        expect(
          delta,
          `${theme} now clears the ${channel} floor (${delta.toFixed(2)}) - remove it from KNOWN_UNSAFE`
        ).toBeLessThan(CVD_SAFETY_FLOOR);
      }
    });
  });
});

/**
 * Proof the harness is not vacuous: each property, run against a fixture that
 * should fail it. cave's fixture is the literal pre-retune hex pair frozen
 * inline (not read from tokens.ts) so this proof survives the parallel retune
 * landing - it documents what the harness would have caught, permanently.
 */
describe('proof: the harness catches real regressions', () => {
  it('property 1 rejects the pre-retune cave ramp (the screenshot bug)', () => {
    const delta = endpointDiscriminability('#a89060', '#b85048');
    expect(delta).toBeLessThan(DISCRIMINABILITY_FLOOR);
  });

  it('property 2 rejects a real getDepthColor ramp that loops back', () => {
    // Fed through `monotonicityViolations`, i.e. the SAME function the four
    // theme properties call, sweeping the production `getDepthColor`. The
    // previous version of this proof passed a hand-written hex list to a
    // second, test-local copy of the monotonicity logic, so literal in ->
    // test-local helper -> assert: no change to any shipped file could make it
    // red, and nothing anywhere proved `monotonicityViolations` could return
    // non-zero.
    //
    // Its defence was that `getDepthColor` "cannot produce this shape from a
    // 2-stop linear interpolation". That is false and measurable: 48,814 of
    // 200,000 random hex pairs (24.4%) swept through the real `getDepthColor`
    // violate monotonicity.
    //
    // #606a7d -> #f4cb5c is one of them, and the mechanism is ordinary: the
    // shallow end is a desaturated slate (hue 219, S 0.13, L 0.43), the deep
    // end a vivid yellow (hue 44, S 0.87, L 0.66). `interpolateHue` takes the
    // shortest path, 219 -> 44 descending through cyan and green, while S and L
    // climb the whole way - so the mid-ramp greens land FURTHER from the
    // shallow endpoint (peak 55.72 dE00) than the deep endpoint itself does
    // (48.41). Distance from shallow rises, then falls back by 7.31 dE00 -
    // 146x MONOTONICITY_EPS, so this is nowhere near quantization noise - and
    // four samples repeat a distance an earlier sample already passed through,
    // i.e. four pairs of distinct depths that render near-identically.
    expect(monotonicityViolations('#606a7d', '#f4cb5c')).toBeGreaterThan(0);
  });

  it('property 3 rejects a shallow-blue to deep-red pair (the one_dark-class bug)', () => {
    // Shallow hue ~210 (blue) with a reddish deep forces the shortest HSL path
    // up through violet/magenta rather than down through yellow/orange - the
    // exact mechanism documented at tokens.ts:440-445 for one_dark pre-fix.
    const incursion = maxHueIncursion('#3369ff', '#ff2222');
    expect(incursion).toBeGreaterThan(0);
  });

  it('property 4 rejects an iso-luminant green/red pair under deuteranopia simulation', () => {
    // Equal-ish lightness, hue-only separation: the classic colourblind-unsafe
    // combination (differs by hue alone, so a deuteranope's collapsed L-M
    // channel leaves almost nothing to discriminate).
    const { deuteranopia } = cvdSafetyDeltas('#4caf50', '#f44336');
    expect(deuteranopia).toBeLessThan(CVD_SAFETY_FLOOR);
  });
});

/**
 * Reference conformance for `deltaE2000` itself. Everything above reports
 * confident numbers only if the formula underneath is right, and CIEDE2000 is
 * notoriously easy to get subtly wrong (the hue-difference branch, the mean-hue
 * wraparound, the Rt rotation term) in ways that still produce plausible-looking
 * output. These are the 34 CIELAB pairs from Table I of Sharma, Wu & Dalal
 * (2005), published precisely so an implementation can be verified; they were
 * transcribed from the paper itself, not from a third-party restatement. Several
 * pairs exist only to exercise the traps: 9-12 straddle the h' 0/360 boundary,
 * 13-15 straddle the mean-hue wraparound, 7-8 check symmetry through a zero
 * chroma, and 25-34 are the real-surface-colour cases.
 */
describe('deltaE2000 conformance: Sharma, Wu & Dalal (2005) Table I', () => {
  const REFERENCE_VECTORS: ReadonlyArray<readonly [number, Lab, Lab, number]> = [
    [1, [50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425],
    [2, [50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615],
    [3, [50.0, 2.8361, -74.02], [50.0, 0.0, -82.7485], 3.4412],
    [4, [50.0, -1.3802, -84.2814], [50.0, 0.0, -82.7485], 1.0],
    [5, [50.0, -1.1848, -84.8006], [50.0, 0.0, -82.7485], 1.0],
    [6, [50.0, -0.9009, -85.5211], [50.0, 0.0, -82.7485], 1.0],
    [7, [50.0, 0.0, 0.0], [50.0, -1.0, 2.0], 2.3669],
    [8, [50.0, -1.0, 2.0], [50.0, 0.0, 0.0], 2.3669],
    [9, [50.0, 2.49, -0.001], [50.0, -2.49, 0.0009], 7.1792],
    [10, [50.0, 2.49, -0.001], [50.0, -2.49, 0.001], 7.1792],
    [11, [50.0, 2.49, -0.001], [50.0, -2.49, 0.0011], 7.2195],
    [12, [50.0, 2.49, -0.001], [50.0, -2.49, 0.0012], 7.2195],
    [13, [50.0, -0.001, 2.49], [50.0, 0.0009, -2.49], 4.8045],
    [14, [50.0, -0.001, 2.49], [50.0, 0.001, -2.49], 4.8045],
    [15, [50.0, -0.001, 2.49], [50.0, 0.0011, -2.49], 4.7461],
    [16, [50.0, 2.5, 0.0], [50.0, 0.0, -2.5], 4.3065],
    [17, [50.0, 2.5, 0.0], [73.0, 25.0, -18.0], 27.1492],
    [18, [50.0, 2.5, 0.0], [61.0, -5.0, 29.0], 22.8977],
    [19, [50.0, 2.5, 0.0], [56.0, -27.0, -3.0], 31.903],
    [20, [50.0, 2.5, 0.0], [58.0, 24.0, 15.0], 19.4535],
    [21, [50.0, 2.5, 0.0], [50.0, 3.1736, 0.5854], 1.0],
    [22, [50.0, 2.5, 0.0], [50.0, 3.2972, 0.0], 1.0],
    [23, [50.0, 2.5, 0.0], [50.0, 1.8634, 0.5757], 1.0],
    [24, [50.0, 2.5, 0.0], [50.0, 3.2592, 0.335], 1.0],
    [25, [60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [26, [63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
    [27, [61.2901, 3.7196, -5.3901], [61.4292, 2.248, -4.962], 1.8731],
    [28, [35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
    [29, [22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    [30, [36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
    [31, [90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441],
    [32, [90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
    [33, [6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
    [34, [2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ];

  /**
   * Absolute tolerance for the reference comparison, asserted directly rather
   * than through `toBeCloseTo`'s `numDigits`, so the actual budget is visible
   * instead of being encoded as a power of ten.
   *
   * It was `toBeCloseTo(expected, 4)`, i.e. |diff| < 5.0e-5. Pair 23 lands at
   * 4.950e-5 - 99% of that budget. The residual is not an implementation error;
   * it is the paper's own rounding, since Table I is published to 4 decimal
   * places. At 99% of budget any floating-point drift at all (a V8 upgrade, a
   * changed `Math.cbrt` or `Math.pow` implementation) turns pair 23 red for no
   * reason, and the natural "fix" for a spurious red is to weaken the test.
   *
   * 1e-3 is 20x the worst residual today and still tight enough to catch the
   * traps this table exists for, which move results by 1e-3 to 1e0, not by
   * 1e-5. Measured by forcing `rt` to 0 (the Rt rotation term is the classic
   * CIEDE2000 implementation error): 9 of the 34 pairs fail at this tolerance,
   * residuals from 1.459e-3 (pair 27) to 4.849 (pair 19), with pair 29 at 1.129
   * and pairs 1-3 at 0.434-0.907.
   *
   * Note pair 27's 1.459e-3: it is only 1.5x this tolerance, so 1e-3 is close
   * to the loosest value that still catches a zeroed Rt on that pair. Loosen
   * further and real defects start slipping through; tighten back toward the
   * 4.950e-5 residual and pair 23 goes red on floating-point drift alone.
   *
   * Do NOT tighten this without re-measuring the worst residual first; the
   * headroom is the point.
   */
  const DE2000_TOLERANCE = 1e-3;

  it('covers the full published table, and the sweep over it is non-empty', () => {
    // Not a length literal. Two things are asserted that a change can break:
    // (1) the table is non-empty, because the `.each` below is a plain
    //     `forEach` in vitest 2.1.9 - an empty table silently registers zero
    //     conformance tests and every dE00 number this file reports becomes
    //     unverified while the run stays green (same failure mode as
    //     THEMES_WITH_DEPTH_RAMP above);
    // (2) the pair indices are exactly 1..34 in the paper's order, which a bare
    //     length check cannot see - a hand-transcribed table's realistic
    //     editing accidents are a duplicated row, a row pasted over its
    //     neighbour, or a renumbered index, and all three preserve the length.
    expect(REFERENCE_VECTORS.length).toBeGreaterThan(0);
    expect(REFERENCE_VECTORS.map(([i]) => i)).toEqual(
      Array.from({ length: 34 }, (_, k) => k + 1)
    );
  });

  it.each(REFERENCE_VECTORS)('pair %i matches the published dE00 within 1e-3', (_i, lab1, lab2, expected) => {
    const actual = deltaE2000(lab1, lab2);
    expect(
      Math.abs(actual - expected),
      `dE00 ${actual} differs from the published ${expected} by more than ${DE2000_TOLERANCE}`
    ).toBeLessThan(DE2000_TOLERANCE);
  });
});
