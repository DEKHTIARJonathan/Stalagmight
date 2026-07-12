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
 * while the light theme is active. Colors are chosen for visibility on
 * light backgrounds.
 */
export const lightDisplayDefaults: DisplayConfig = {
  default_background: themeTokens.light['--cc-background'],
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
  measure_path_color: '#22d3ee',
};

/**
 * Light-theme section color palette. Darker/more saturated colors that
 * are visually distinct on light backgrounds.
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
    '#c7873a',
  ],
};

/** Themes that use light-mode display defaults (light backgrounds). */
const LIGHT_THEMES = new Set(['light', 'solarized_light', 'catppuccin_latte', 'kaleido_eink']);

/**
 * Get theme-appropriate display defaults.
 * Returns light-theme defaults for light-type themes, dark defaults otherwise.
 */
export function getThemedDisplayDefaults(resolvedTheme: string): DisplayConfig {
  if (LIGHT_THEMES.has(resolvedTheme)) {
    return { ...lightDisplayDefaults, depth_gradient: { ...lightDisplayDefaults.depth_gradient } };
  }
  return {
    ...defaultConfig.display,
    depth_gradient: { ...defaultConfig.display.depth_gradient },
  };
}

/**
 * Get theme-appropriate section color defaults.
 * Returns light-theme palette for light-type themes, dark palette otherwise.
 */
export function getThemedSectionColorDefaults(resolvedTheme: string): SectionColorsConfig {
  if (LIGHT_THEMES.has(resolvedTheme)) {
    return { palette: [...lightSectionColorDefaults.palette] };
  }
  return { palette: [...defaultConfig.section_colors.palette] };
}
