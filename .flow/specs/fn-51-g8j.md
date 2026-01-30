# Theme Infrastructure: CSS Variables, ThemeProvider, Dark+Light Themes

## Problem

CaveChef has a single hardcoded dark theme with all colors as literal hex values spread across `tailwind.config.js`, `src/index.css`, and 42+ inline component styles in TSX files. There is no mechanism for users to switch themes, no CSS variable system, and no infrastructure for future high-contrast or custom themes.

## Goals

1. Migrate **all** hardcoded UI and visualization colors to CSS custom properties (`--cc-*` prefix)
2. Ship two working themes: **dark** (existing palette) and **light** (derived from `docs/branding/tokens/brand_tokens.css`)
3. Add `[data-theme]` attribute switching on the document root
4. Persist theme preference in app-level config (Rust TOML backend)
5. Add **Appearance** settings tab with theme selector (Dark / Light / Auto)
6. Auto mode follows OS `prefers-color-scheme`
7. Default to dark theme (no change for existing users)

## Scope

### In scope
- All UI chrome colors: backgrounds, panels, borders, text, accent, scrollbars, inputs, checkboxes, focus rings
- Third-party widget overrides: React DatePicker, MapLibre controls
- Tailwind config color tokens → CSS variable references
- **Map visualization colors**: snap indicators, hover highlights, selection highlights, stroke colors, depth defaults
- **Canvas preview colors**: SectionPreview, PlacementOverlay, DepthLegend, GridOverlay
- **Tailwind opacity modifier migration**: 34 unique patterns (29 theme + 5 non-theme) across `bg|text|border|ring` utilities → dedicated opacity tokens for theme colors (see full inventory below)
- `color-scheme` CSS property on root (affects native select/date inputs)
- MapLibre icon inversion filter made conditional on theme
- Theme influences default color palettes offered in display settings color pickers
- **Config deep-merge plumbing**: `mergeConfig()` and `getCategoryDefaults()` in SettingsDialog.tsx must handle `appearance`
- **E2E mock updates**: `e2e-playwright/mocks/tauri-ipc.ts` must return `appearance` in mock config

### Out of scope
- High-contrast theme (v2.0)
- Per-project theme settings (theme is global/app-level only)
- **ExportPreview.tsx**: Export rendering always uses dark palette (exports are visual artifacts, not UI)
- Section palette colors in `src/utils/colors.ts` SECTION_COLORS (per-project display settings)
- Error severity colors in `getErrorColor()` (functional, not aesthetic)

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| CSS variables (`--cc-*`) over Tailwind `dark:` prefix | More flexible for future themes; works with arbitrary values; single source of truth |
| `[data-theme]` attribute selector | Explicit control, works without media query, composable with `prefers-color-scheme` for auto mode |
| App-level config, not per-project | Theme is user preference, not project data |
| Dark as default | Existing users see no change on update |
| Full migration in one pass | No mixed hardcoded/variable state; clean cut |
| Light theme derived from brand_tokens.css | See brand token mapping table below |
| Dedicated opacity variant tokens | Tailwind opacity modifiers (`bg-accent/10`) break with CSS variable colors. Define explicit `--cc-accent-10` etc. tokens instead |
| Full token set (70+ tokens) | Verbose but explicit. Each color has a semantic name. Future themes just fill in values |
| Exports always dark palette | Export renders are saved visual artifacts, not interactive UI |
| Preview canvases follow theme | Previews in dialogs are interactive UI, should match app theme |
| Default to dark on boot | Config loads async; `:root` CSS defaults to dark; no flash of wrong theme |
| Auto-derive light map colors | Pick light-theme variants that maintain visibility on light backgrounds |
| `accent-on` as first-class Tailwind token | Components needing text-on-accent (e.g. Button primary) use `text-accent-on` instead of `text-background` |
| Explicit alpha tokens over `color-mix()` | Every alpha usage gets its own `--cc-*-NN` token; avoids browser compat issues with `color-mix()` |
| `getThemeColor()` with fallback defaults | Helper returns literal values for MapLibre/canvas; includes fallback map to prevent empty strings on early mount |

## Light Theme Brand Token Mapping

Light theme values are derived from `docs/branding/tokens/brand_tokens.css`. Only tokens that exist in the brand file are referenced directly; others are design decisions documented below.

**Tokens available in brand_tokens.css:**
- `--sm-limestone-50`: #F3E8D8
- `--sm-sandstone-200`: #C1A07A
- `--sm-silt-300`: #AE8D67
- `--sm-cave-ember-700`: #3A251A
- `--sm-cave-ember-900`: #1A120B
- `--sm-basalt-950`: #0F0906

| CSS Variable | Source | Derived Value | Transformation |
|---|---|---|---|
| `--cc-background` | `--sm-limestone-50` (#F3E8D8) | `#f5f0e8` | Slightly cooled (HSL shift -5 warmth) to reduce warmth for large surfaces |
| `--cc-panel` | Design decision (white) | `#ffffff` | Clean white for card/panel surfaces; no brand token exists for white |
| `--cc-border` | `--sm-sandstone-200` (#C1A07A) | `#d4c5a9` | Lightened 20% via HSL for subtler borders |
| `--cc-text-primary` | `--sm-cave-ember-900` (#1A120B) | `#1a120b` | Direct use |
| `--cc-text-secondary` | `--sm-silt-300` (#AE8D67) | `#6b5b4a` | Darkened from silt-300 for WCAG AA contrast on limestone bg |
| `--cc-accent` | Design decision (darkened teal) | `#3a8a82` | No teal token in brand file; darkened from dark-theme accent #4ecdc4 for light bg contrast |
| `--cc-accent-on` | Design decision (white) | `#ffffff` | White text on darkened accent; no brand token needed |

All light values must pass WCAG AA (4.5:1 text contrast, 3:1 UI contrast).

## MapLibre Re-styling Architecture

MapLibre GL JS does NOT read CSS variables. Colors must be literal values. The re-styling flow:

1. `useTheme` hook resolves theme → stores `resolvedTheme` in `uiStore`
2. `getMapThemeColors()` utility reads CSS variables via `getComputedStyle()` → returns color map object
3. `getThemeColor()` includes a **fallback map** with dark-theme defaults for each variable, preventing empty strings if called before CSS loads

**Integration points for re-apply on theme change:**

- **`MapCanvas.tsx`** (React component): Subscribes to `useUIStore((s) => s.resolvedTheme)`. On change, calls `surveyLayer.applyThemeColors(getMapThemeColors())` for all theme-dependent paint/layout properties.
- **`SurveyLayer.tsx`** (class): Receives `applyThemeColors(colors)` method call from MapCanvas. Iterates all theme-dependent layers and calls `map.setPaintProperty()` / `map.setLayoutProperty()` for each. **Also rebuilds feature data** because `buildSurveyFeatures()` in `features.ts` embeds theme-dependent colors (depth defaults, label colors, stroke colors, zero-datum gold) directly in GeoJSON feature properties. On theme change, must call `update()` with cached sections/stations/loopClosures to regenerate features with new theme colors.
- **`features.ts`**: `buildSurveyFeatures()` receives theme colors as a parameter instead of using hardcoded hex values. Default label color, depth gradient colors, zero-datum color, and stroke color are all passed from the theme color map.
- **`SectionPreview.tsx`** (owns MapLibre instance): Adds `useEffect` on `resolvedTheme` that re-reads colors via `getMapThemeColors()` and updates background + all constant paint props (gray lines, compass, strokes, halos).
- **`GlobalSurveyLayer.ts`** (class): Same pattern as SurveyLayer — receives theme colors from parent component and rebuilds features on theme change.

## Complete Opacity Modifier Inventory

34 unique patterns found across the codebase. **29** use theme colors and must be migrated:

### accent family (11 patterns — confirmed by grep)
`bg-accent/5`, `bg-accent/10`, `bg-accent/20`, `bg-accent/30`, `bg-accent/50`, `bg-accent/70`, `bg-accent/80`, `bg-accent/90`, `border-accent/20`, `ring-accent/30`, `text-accent/80`

### background family (3 patterns)
`bg-background/30`, `bg-background/50`, `bg-background/80`

### panel family (3 patterns)
`bg-panel/20`, `bg-panel/50`, `bg-panel/90`

### error family (5 patterns)
`bg-error/10`, `bg-error/90`, `border-error/20`, `border-error/30`, `text-error/80`

### warning family (4 patterns)
`bg-warning/10`, `bg-warning/20`, `border-warning/20`, `border-warning/30`

### success family (3 patterns)
`bg-success/5`, `bg-success/10`, `border-success/30`

### border (additional, already counted above)
All `border-*` patterns are listed in their respective families above.

### Non-theme colors (no migration needed — 5 patterns)
`bg-black/50`, `bg-black/85`, `bg-red-500/20`, `bg-red-500/30`, `bg-yellow-500/20` — these use standard Tailwind colors, not CSS variable colors, so opacity modifiers still work.

## Interview Findings (Codebase Scan)

### Config Deep-Merge Plumbing

Adding `config.appearance` requires updates to internal functions in `src/components/Dialogs/SettingsDialog.tsx`:
- `mergeConfig()` (lines ~183-283): Add `appearance` branch to deep merge logic
- `getCategoryDefaults()` (lines ~65-105): Add `'appearance'` case returning `{ appearance: defaultConfig.appearance }`
- Both functions are **internal** (not exported), defined within SettingsDialog.tsx

### E2E Mock Config

`e2e-playwright/mocks/tauri-ipc.ts` hardcodes `get_config` return values. Must add `appearance: { theme: 'dark' }` to the mock config object to prevent test failures when `Config` type requires the field.

### Correct File Paths

- Settings sidebar + SettingsCategory type: `src/components/Dialogs/SettingsSidebar.tsx` (NOT in `settings/` subdirectory)
- Settings category props: `src/components/Dialogs/settings/types.ts` (in `settings/` subdirectory)
- E2E tests: `e2e-playwright/*.spec.ts` (NOT in `e2e-playwright/tests/`)
- Brand tokens: `docs/branding/tokens/brand_tokens.css`

### Button.tsx On-Accent Pattern

`src/components/common/Button.tsx` line 14 uses `text-background` as on-accent text color: `primary: 'bg-accent text-background hover:bg-accent/90'`. In light theme, `background` becomes light (#f5f0e8), making text invisible on accent. Must migrate to `text-accent-on` which maps to `--cc-accent-on` (dark in dark theme, white in light theme).

### Config Loading Timing

Config loads asynchronously via `useEffect` in App.tsx. The `useTheme` hook must handle `config === null` by defaulting to `'dark'`. Since `:root` CSS already defaults to dark theme, there is no flash of incorrect theme.

## CSS Variable Token Inventory

### UI Chrome Tokens
```
--cc-background, --cc-panel, --cc-border
--cc-text-primary, --cc-text-secondary
--cc-accent, --cc-accent-on
--cc-warning, --cc-error, --cc-success
--cc-hover, --cc-focus-ring, --cc-focus-glow
--cc-scrollbar-track, --cc-scrollbar-thumb, --cc-scrollbar-hover
--cc-input-bg, --cc-input-border
--cc-outside-month
--cc-selection-gradient
```

### MapLibre Tokens
```
--cc-map-ctrl-bg, --cc-map-ctrl-border, --cc-map-ctrl-hover, --cc-map-ctrl-active
--cc-map-ctrl-icon-filter
--cc-map-ctrl-shadow
--cc-map-scale-bg, --cc-map-scale-border, --cc-map-scale-text
```

### Map Visualization Tokens
```
--cc-snap-color, --cc-hover-highlight, --cc-select-highlight
--cc-stroke-color, --cc-stroke-light
--cc-text-halo, --cc-text-halo-alt
--cc-station-default, --cc-gray-line, --cc-gray-text
--cc-grid-default, --cc-zero-datum, --cc-compass-color
--cc-depth-shallow, --cc-depth-deep, --cc-depth-text
```

### Canvas Preview Tokens
```
--cc-preview-bg, --cc-preview-text
```

### Opacity Variant Tokens (29 unique values — some serve multiple utility prefixes)
```
accent: --cc-accent-5, --cc-accent-10, --cc-accent-20, --cc-accent-30, --cc-accent-50, --cc-accent-70, --cc-accent-80, --cc-accent-90
background: --cc-background-30, --cc-background-50, --cc-background-80
panel: --cc-panel-20, --cc-panel-50, --cc-panel-90
error: --cc-error-10, --cc-error-90, --cc-error-20, --cc-error-30, --cc-error-80
warning: --cc-warning-10, --cc-warning-20, --cc-warning-30
success: --cc-success-5, --cc-success-10, --cc-success-30
ring: --cc-accent-30 (reused from accent family)
```

Note: Some tokens serve multiple utility prefixes (e.g. `--cc-accent-20` is used for both `bg-accent-20` and `border-accent-20`).

## Task Breakdown

1. **Define CSS variable tokens and theme definitions** — All `--cc-*` variables in index.css including full 29-pattern opacity inventory, shadow token, accent-on, with dark and light theme blocks
2. **Update tailwind.config.js** — Reference CSS variables; add ALL 29 opacity variant entries + `accent-on`
3. **Migrate index.css hardcoded colors** — Replace all hex values with `var(--cc-*)` references; use explicit alpha tokens for shadows
4. **Add AppearanceConfig to config system** — TypeScript types + Rust struct + defaults + mergeConfig + getCategoryDefaults + e2e mock
5. **Create useTheme hook** — Reads config, resolves auto mode, applies data-theme attribute, stores resolvedTheme in uiStore
6. **Create AppearanceSettings tab** — Settings UI with theme selector, wired into SettingsDialog (correct paths: SettingsSidebar.tsx at Dialogs root, not settings/ subdirectory)
7. **Handle MapLibre controls and third-party widget theming** — Conditional icon filter, DatePicker
8. **Update default color palettes for light theme** — DisplaySettings color pickers offer theme-appropriate defaults
9. **Add E2E tests for theme switching** — At `e2e-playwright/theme.spec.ts` (NOT in tests/ subdirectory)
10. **Migrate inline hex colors in TSX components** — Create `themeColors.ts` utility with fallback map; wire MapCanvas→SurveyLayer.applyThemeColors() and SectionPreview re-apply; replace Button.tsx `text-background` with `text-accent-on`; exclude ExportPreview
11. **Migrate Tailwind opacity modifier usage** — Replace ALL 29 theme-color opacity patterns across `bg|text|border|ring` utilities

## Files Modified

| File | Change |
|------|--------|
| `src/index.css` | Add CSS variable definitions (70+ tokens), migrate all hardcoded colors; explicit alpha tokens for shadows |
| `tailwind.config.js` | Reference CSS variables, add all 30 opacity variant entries + accent-on |
| `src/types/config.ts` | Add `AppearanceConfig`, `ThemeMode` |
| `src-tauri/src/config/types.rs` | Add `AppearanceConfig` struct |
| `src-tauri/src/config/defaults.rs` | Add `Default` impl |
| `src/hooks/useTheme.ts` | New: theme resolution and application hook |
| `src/App.tsx` | Call `useTheme()` at app root |
| `src/utils/themeColors.ts` | New: `getThemeColor()` with fallback map + `getMapThemeColors()` |
| `src/store/uiStore.ts` | Add `resolvedTheme` state |
| `src/components/Dialogs/settings/AppearanceSettings.tsx` | New: Appearance tab |
| `src/components/Dialogs/SettingsDialog.tsx` | Add Appearance rendering, mergeConfig, getCategoryDefaults |
| `src/components/Dialogs/SettingsSidebar.tsx` | Add to SettingsCategory type + CATEGORIES array |
| `src/components/Map/SurveyLayer.tsx` | Replace 13 hardcoded colors; add `applyThemeColors()` method |
| `src/components/Map/MapCanvas.tsx` | Subscribe to resolvedTheme; call surveyLayer.applyThemeColors on change |
| `src/components/Map/surveyLayer/features.ts` | Accept theme colors parameter; replace hardcoded depth/station/label colors |
| `src/components/GlobalView/GlobalSurveyLayer.ts` | Replace 8 hardcoded colors; add theme re-apply method |
| `src/components/GlobalView/GlobalViewMap.tsx` | Replace 8 hardcoded colors |
| `src/components/Dialogs/SectionPreview.tsx` | Replace 12 colors; add useEffect on resolvedTheme for re-apply |
| `src/components/Map/PlacementOverlay.tsx` | Replace 6 snap/anchor colors |
| `src/components/Map/GridOverlay.tsx` | Replace grid color default |
| `src/components/Map/DepthLegend.tsx` | Replace 3 depth/text colors |
| `src/components/common/Button.tsx` | Replace `text-background` with `text-accent-on`; replace opacity modifiers |
| `src/components/common/SectionMetadataForm.tsx` | Replace placeholder color |
| `src/components/Dialogs/EditSectionDialog.tsx` | Replace default section color |
| `e2e-playwright/mocks/tauri-ipc.ts` | Add `appearance` to mock config |
| `e2e-playwright/theme.spec.ts` | New: E2E tests for theme switching |

## Risks

- **Tailwind + CSS variables**: Opacity modifiers break. Mitigated by dedicated opacity tokens covering all 29 theme-color patterns (tasks 1, 11).
- **Large scope**: 70+ CSS variables, 20+ files to modify. Mitigated by systematic task breakdown and grep-driven migration.
- **MapLibre style expressions**: MapLibre GL JS does NOT read CSS variables. Concrete integration points defined: MapCanvas→SurveyLayer.applyThemeColors(), SectionPreview useEffect on resolvedTheme, GlobalSurveyLayer theme re-apply method.
- **Third-party widget overrides**: DatePicker and MapLibre use `!important`. All must be converted (task 7).
- **SettingsCategory type**: Defined in `src/components/Dialogs/SettingsSidebar.tsx` (NOT in settings/ subdirectory). Task 6 must modify the correct file.
- **Config deep-merge plumbing**: `mergeConfig()` and `getCategoryDefaults()` are internal to SettingsDialog.tsx. Must add `appearance` branch to both (task 4).
- **E2E mock config**: `e2e-playwright/mocks/tauri-ipc.ts` hardcodes config return values. Must add `appearance` field (task 4).
- **Button on-accent text**: `text-background` breaks in light theme. Must migrate to `text-accent-on` (task 10).
- **getThemeColor early mount**: Can return empty string before CSS loads. Mitigated by fallback map with dark-theme defaults (task 10).
- **Alpha values in index.css**: Some CSS rules use rgba for shadows/overlays. Cannot apply alpha to `var()`. Mitigated by explicit alpha tokens (`--cc-map-ctrl-shadow`, opacity variant tokens).
- **Brand token traceability**: Light theme values must map back to `docs/branding/tokens/brand_tokens.css`. Mapping table included in spec. Non-brand-sourced values documented as design decisions.
- **GeoJSON feature rebuild**: `buildSurveyFeatures()` in `features.ts` embeds theme-dependent colors (depth defaults, label colors, stroke, zero-datum) in GeoJSON properties. Theme change requires feature data rebuild, not just paint property updates. SurveyLayer must cache last input data and call `update()` on theme change.
