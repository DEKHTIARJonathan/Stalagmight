import { themeTokens } from '../theme/tokens';
import type { DisplayConfig, SectionColorsConfig } from './ipc.generated';
import { defaultConfig } from './ipc/defaultConfig';

export { defaultConfig };

export type {
  LengthUnit,
  AngleUnit,
  DecimalPrecision,
  ShortcutFeedback,
  ThemeMode,
  ColorTheme,
  AppearanceConfig,
  ImportConfig,
  OverlapMode,
  Config,
  GeneralConfig,
  UnitsConfig,
  DisplayConfig,
  DepthGradientConfig,
  SectionColorsConfig,
  GpsOrigin,
  StationConfig,
  ShotConfig,
  MapSnapConfig,
  MapAnimationConfig,
  DebugConfig,
  MapDebugConfig,
  MapConfig,
  MapControlsConfig,
  ValidationConfig,
  ClosureAdjustmentConfig,
  PlacementSuggestionConfig,
  ExportConfig,
  LoggingConfig,
  ShortcutsConfig,
  PanelsConfig,
  CacheConfig,
  GlobalViewConfig,
  SyntacticHighlightingConfig,
  SyntacticHighlightLevel,
  SyntacticHighlightPreset,
} from './ipc.generated';

/**
 * Bounds for `speleodb.poll_interval_seconds` (the action-shell remote-state
 * poll). The floor mirrors `MIN_POLL_INTERVAL_SECONDS` in `config/types.rs` (the
 * Settings UI blocks Save below it; the backend re-clamps a hand-edited file on
 * load). The ceiling keeps a huge value from effectively disabling the poll (and
 * clear of setInterval's 32-bit delay overflow). Shared so the Settings panel and
 * the status button agree.
 */
export const MIN_POLL_INTERVAL_SECONDS = 30;
export const MAX_POLL_INTERVAL_SECONDS = 24 * 60 * 60;

/**
 * Light-theme display defaults. Used when "Reset to defaults" is triggered
 * while a light-CANVAS theme is active. Colors are chosen for visibility on
 * the light map canvas (`--cc-map-background`), which is what they are drawn on.
 */
export const lightDisplayDefaults: DisplayConfig = {
  grid_color: '#c1a07a',
  grid_spacing: 10,
  font_size: 12,
  font_color: themeTokens.light['--cc-text-primary'],
  depth_gradient: {
    enabled: false,
    shallow_color: '#0077b6',
    deep_color: '#c1121f',
    shallow_depth: 0.0,
    deep_depth: 50.0,
  },
  // #357 item 17: the dark default is `#22d3ee`, a bright cyan that measures
  // 1.69:1 on light's `#faf7f2` - the ruler's measured path was all but invisible
  // even after resetting Display settings, because these defaults specified the
  // same cyan. Dark green instead of a dark cyan: hue ~130 is the one region the
  // light map palette leaves free. It clears the selection highlight (`#3a8a82`),
  // the hover/zero-datum gold (`#b8860b`), the snap brick (`#c0392b`), both ends
  // of the distance/gas overlay ramp (`#f4d03f` -> `#7d3c98`), and - unlike any
  // violet - it sits entirely outside the light depth ramp's hue arc, which runs
  // FORWARD from navy 211 through indigo and magenta to brick 7. 4.87:1, pinned
  // by "light default measure color clears the floor" in __tests__/config.test.ts.
  measure_path_color: '#157e27',
};

/**
 * Light-theme section color palette. Darker/more saturated colors that are
 * visually distinct on light backgrounds. Every entry must clear 3:1 against the
 * light canvas (`#faf7f2`); the guard in `__tests__/config.test.ts` measures it.
 */
export const lightSectionColorDefaults: SectionColorsConfig = {
  palette: [
    '#1a8a7d',
    '#c0392b',
    '#2e7d6e',
    '#b94a4a',
    '#6b4fa0',
    '#c4587a',
    '#2f7d9e',
    // #357 item 9: was `#c7873a`, which measured 2.83:1 on `#faf7f2` - the one
    // entry of this "light" palette that was itself below the floor. Same hue,
    // darker: 4.14:1.
    '#a86a1e',
  ],
};

/**
 * Themes whose MAP CANVAS is light, so map-drawn defaults must be dark ink.
 *
 * Keyed on `--cc-map-background`, NOT on the chrome: `solarized_light` and
 * `catppuccin_latte` are chrome-only light themes that deliberately leave the
 * map-visualization tokens unset (see `mapVizTokenNames`), so their canvas is
 * `:root`'s dark `#1a1a2e` and the DARK defaults are the correct ones for them.
 * Treating them as light handed them `#6b4fa0` at 2.64:1 on that dark canvas.
 * `mapCanvasFor` below derives the same split from the tokens, and the test
 * "light-canvas themes are exactly the ones with a light map background" pins
 * this set against it so the two cannot drift.
 */
const LIGHT_CANVAS_THEMES = new Set(['light', 'kaleido_eink']);

/**
 * The map canvas a theme actually paints on. Chrome-only themes inherit `:root`'s
 * dark canvas because they declare no `--cc-map-background` of their own.
 */
export function mapCanvasFor(resolvedTheme: string): string {
  const tokens = (themeTokens as Record<string, Record<string, string> | undefined>)[resolvedTheme];
  return tokens?.['--cc-map-background'] ?? themeTokens.dark['--cc-map-background'];
}

/**
 * Get theme-appropriate display defaults.
 * Returns light-theme defaults for light-CANVAS themes, dark defaults otherwise.
 */
export function getThemedDisplayDefaults(resolvedTheme: string): DisplayConfig {
  if (LIGHT_CANVAS_THEMES.has(resolvedTheme)) {
    return { ...lightDisplayDefaults, depth_gradient: { ...lightDisplayDefaults.depth_gradient } };
  }
  return {
    ...defaultConfig.display,
    depth_gradient: { ...defaultConfig.display.depth_gradient },
  };
}

/**
 * Get theme-appropriate section color defaults.
 * Returns light-theme palette for light-CANVAS themes, dark palette otherwise.
 */
export function getThemedSectionColorDefaults(resolvedTheme: string): SectionColorsConfig {
  if (LIGHT_CANVAS_THEMES.has(resolvedTheme)) {
    return { palette: [...lightSectionColorDefaults.palette] };
  }
  return { palette: [...defaultConfig.section_colors.palette] };
}
