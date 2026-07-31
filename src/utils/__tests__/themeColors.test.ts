// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { getMapThemeColors, getThemeColor, withThemeDepthColors } from '../themeColors';
import { themeTokens } from '../../theme/tokens';
import { DEFAULT_IMAGE_OPTIONS } from '../../store/exportStore';

/**
 * MapLibre and the custom WebGL layers cannot read CSS variables, so every map colour
 * has to be resolved to a literal string here. The property worth pinning is that they
 * are resolved from the LIVE document rather than from a build-time constant: a colour
 * hardcoded in this module silently ignores whatever the active theme declares, and no
 * token-parity test can see that, because the token itself is present and correct.
 */

const MAP_TOKENS = [
  '--cc-map-background',
  '--cc-stroke-color',
  '--cc-depth-shallow',
  '--cc-depth-deep',
  '--cc-depth-text',
  '--cc-grid-default',
  '--cc-compass-color',
] as const;

afterEach(() => {
  for (const token of MAP_TOKENS) {
    document.documentElement.style.removeProperty(token);
  }
});

describe('getThemeColor', () => {
  it('reads the live custom property', () => {
    document.documentElement.style.setProperty('--cc-map-background', '#123456');
    expect(getThemeColor('--cc-map-background')).toBe('#123456');
  });

  it('falls back to the dark token when the property is unset', () => {
    expect(getThemeColor('--cc-map-background')).toBe(
      themeTokens.dark['--cc-map-background']
    );
  });
});

describe('getMapThemeColors', () => {
  it.each([
    ['background', '--cc-map-background'],
    ['strokeColor', '--cc-stroke-color'],
    // The depth pair is the reason this file exists. Both were pinned to
    // themeTokens.dark for every theme, so the light canvas drew its depth gradient
    // in colours picked for a dark background (#332).
    ['depthShallow', '--cc-depth-shallow'],
    ['depthDeep', '--cc-depth-deep'],
    ['labelColor', '--cc-depth-text'],
    ['gridDefault', '--cc-grid-default'],
    ['compassColor', '--cc-compass-color'],
  ] as const)('resolves %s from %s at call time', (field, token) => {
    document.documentElement.style.setProperty(token, '#abcdef');
    expect(getMapThemeColors()[field]).toBe('#abcdef');
  });

  it('re-reads on every call, so a theme flip is picked up', () => {
    document.documentElement.style.setProperty('--cc-depth-shallow', '#111111');
    expect(getMapThemeColors().depthShallow).toBe('#111111');
    document.documentElement.style.setProperty('--cc-depth-shallow', '#222222');
    expect(getMapThemeColors().depthShallow).toBe('#222222');
  });

  it('keeps issue-severity colours fixed across themes', () => {
    // These are deliberately NOT theme-derived: severity has to read the same
    // everywhere. Pinned so the depth fix above is not later copied onto them.
    const before = getMapThemeColors();
    document.documentElement.style.setProperty('--cc-map-background', '#ffffff');
    const after = getMapThemeColors();
    expect(after.severityClear).toBe(before.severityClear);
    expect(after.severityWarning).toBe(before.severityWarning);
    expect(after.severityError).toBe(before.severityError);
  });
});

describe('withThemeDepthColors', () => {
  // #360: depth-mode PNG/PDF export used to hardcode the `dark` theme's
  // endpoints in Rust regardless of the active theme. This is the frontend
  // half of the fix: the export/preview call sites must send the ACTIVE
  // theme's own `--cc-depth-shallow` / `--cc-depth-deep`, not a fixed pair -
  // a test only exercising one theme cannot fail for this bug.
  it('resolves depth_shallow/depth_deep from the live theme when unset', () => {
    document.documentElement.style.setProperty('--cc-depth-shallow', '#a89060');
    document.documentElement.style.setProperty('--cc-depth-deep', '#b85048');
    const result = withThemeDepthColors(DEFAULT_IMAGE_OPTIONS);
    expect(result.depth_shallow).toBe('#a89060');
    expect(result.depth_deep).toBe('#b85048');
  });

  it('sends different endpoints for different active themes', () => {
    document.documentElement.style.setProperty('--cc-depth-shallow', '#a89060');
    document.documentElement.style.setProperty('--cc-depth-deep', '#b85048');
    const cave = withThemeDepthColors(DEFAULT_IMAGE_OPTIONS);

    document.documentElement.style.setProperty('--cc-depth-shallow', '#1a2f6b');
    document.documentElement.style.setProperty('--cc-depth-deep', '#8b2f2f');
    const light = withThemeDepthColors(DEFAULT_IMAGE_OPTIONS);

    expect(cave.depth_shallow).not.toBe(light.depth_shallow);
    expect(cave.depth_deep).not.toBe(light.depth_deep);
    expect(light.depth_shallow).toBe('#1a2f6b');
    expect(light.depth_deep).toBe('#8b2f2f');
  });

  it('does not override an explicitly set value', () => {
    document.documentElement.style.setProperty('--cc-depth-shallow', '#a89060');
    const result = withThemeDepthColors({
      ...DEFAULT_IMAGE_OPTIONS,
      depth_shallow: '#custom',
    });
    expect(result.depth_shallow).toBe('#custom');
  });
});
