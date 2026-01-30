# Theme Infrastructure: CSS Variables, ThemeProvider, Dark+Light Themes

## Problem

CaveChef has a single hardcoded dark theme with all colors as literal hex values spread across `tailwind.config.js`, `src/index.css`, and 42+ inline component styles in TSX files. There is no mechanism for users to switch themes, no CSS variable system, and no infrastructure for future high-contrast or custom themes.

## Goals

1. Migrate **all** hardcoded UI and visualization colors to CSS custom properties (`--cc-*` prefix)
2. Ship two working themes: **dark** (existing palette) and **light** (derived from `brand_tokens.css`)
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
- **Tailwind opacity modifier migration**: 36+ instances of `bg-color/opacity` syntax → dedicated opacity tokens
- `color-scheme` CSS property on root (affects native select/date inputs)
- MapLibre icon inversion filter made conditional on theme
- Theme influences default color palettes offered in display settings color pickers

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
| Light theme derived from brand_tokens.css | Leverages existing brand palette; warm tones differentiate from generic light themes |
| Dedicated opacity variant tokens | Tailwind opacity modifiers (`bg-accent/10`) break with CSS variable colors. Define explicit `--cc-accent-10` etc. tokens instead |
| Full token set (40+ tokens) | Verbose but explicit. Each color has a semantic name. Future themes just fill in values |
| Exports always dark palette | Export renders are saved visual artifacts, not interactive UI |
| Preview canvases follow theme | Previews in dialogs are interactive UI, should match app theme |
| Default to dark on boot | Config loads async; `:root` CSS defaults to dark; no flash of wrong theme |
| Auto-derive light map colors | Pick light-theme variants that maintain visibility on light backgrounds |

## Interview Findings (Codebase Scan)

### Critical Issue: Tailwind Opacity Modifiers (36+ instances)

These patterns will break when Tailwind colors become CSS variables:
- `bg-background/80` → needs `--cc-background-80`
- `bg-panel/50` → needs `--cc-panel-50`
- `bg-accent/90`, `bg-accent/20`, `bg-accent/10` → needs `--cc-accent-90`, `--cc-accent-20`, `--cc-accent-10`
- `hover:bg-accent/10` → needs `--cc-accent-10`
- `bg-warning/10`, `border-warning/30` → needs opacity tokens
- `bg-panel/90` → needs `--cc-panel-90`

**Solution**: Define explicit opacity variant CSS variables and replace Tailwind opacity syntax with these tokens.

### Inline Hex Colors in Components (42+ instances)

Major files with hardcoded colors requiring migration:
- `SurveyLayer.tsx` (13 colors: station colors, strokes, hover/select highlights, text halos)
- `GlobalSurveyLayer.ts` (8 colors: strokes, fallbacks, gray text)
- `ExportPreview.tsx` (8 colors: **EXCLUDED** - always uses dark palette)
- `SectionPreview.tsx` (12 colors: background, lines, circles, strokes, compass)
- `PlacementOverlay.tsx` (6 colors: snap indicators, anchors)
- `GlobalViewMap.tsx` (8 colors: text, borders, error indicators)
- `MapCanvas.tsx` (1: background default)
- `GridOverlay.tsx` (1: grid color default)
- `DepthLegend.tsx` (3: depth defaults, text)
- `SectionMetadataForm.tsx` (1: placeholder color)
- `EditSectionDialog.tsx` (1: default section color)

### Config Loading Timing

Config loads asynchronously via `useEffect` in App.tsx. The `useTheme` hook must handle `config === null` by defaulting to `'dark'`. Since `:root` CSS already defaults to dark theme, there is no flash of incorrect theme.

## CSS Variable Token Inventory

### UI Chrome Tokens (existing plan)
```
--cc-background, --cc-panel, --cc-border
--cc-text-primary, --cc-text-secondary
--cc-accent, --cc-accent-on
--cc-warning, --cc-error, --cc-success
--cc-hover, --cc-focus-ring, --cc-focus-glow
--cc-scrollbar-track, --cc-scrollbar-thumb, --cc-scrollbar-hover
--cc-input-bg, --cc-input-border
--cc-outside-month
```

### MapLibre Tokens (existing plan)
```
--cc-map-ctrl-bg, --cc-map-ctrl-border, --cc-map-ctrl-hover, --cc-map-ctrl-active
--cc-map-ctrl-icon-filter
--cc-map-scale-bg, --cc-map-scale-border, --cc-map-scale-text
```

### Map Visualization Tokens (NEW from interview)
```
--cc-snap-color           (dark: #00ffcc, light: auto-derive)
--cc-hover-highlight      (dark: #0066ff, light: auto-derive)
--cc-select-highlight     (dark: #00aaff, light: auto-derive)
--cc-stroke-color         (dark: #000000, light: #000000 — works on both)
--cc-stroke-light         (dark: #ffffff, light: auto-derive)
--cc-text-halo            (dark: #000000 / #1a1a2e, light: auto-derive)
--cc-station-default      (dark: #4ecdc4, light: auto-derive)
--cc-gray-line            (dark: #888888, light: auto-derive)
--cc-gray-text            (dark: #aaa, light: auto-derive)
--cc-grid-default         (dark: #333366, light: auto-derive)
--cc-zero-datum           (dark: #ffd700, light: #ffd700 — gold works on both)
--cc-compass-color        (dark: #ffcc00, light: auto-derive)
--cc-depth-shallow        (dark: #00bfff, light: auto-derive)
--cc-depth-deep           (dark: #ff4444, light: auto-derive)
--cc-depth-text           (dark: rgba(255,255,255,0.7), light: auto-derive)
```

### Canvas Preview Tokens (NEW from interview)
```
--cc-preview-bg           (dark: #1a1a2e, light: follows --cc-background)
--cc-preview-text         (dark: #ffffff, light: follows --cc-text-primary)
```

### Opacity Variant Tokens (NEW from interview)
```
--cc-background-80        (dark: rgba(26, 26, 46, 0.8))
--cc-panel-50             (dark: rgba(22, 33, 62, 0.5))
--cc-panel-90             (dark: rgba(22, 33, 62, 0.9))
--cc-accent-10            (dark: rgba(78, 205, 196, 0.1))
--cc-accent-20            (dark: rgba(78, 205, 196, 0.2))
--cc-accent-90            (dark: rgba(78, 205, 196, 0.9))
--cc-warning-10           (dark: rgba(255, 203, 119, 0.1))
--cc-warning-30           (dark: rgba(255, 203, 119, 0.3))
```
(Exact set to be determined by grepping all Tailwind opacity modifier usage)

## Task Breakdown

1. **Define CSS variable tokens and theme definitions** — All `--cc-*` variables in index.css including UI chrome, map visualization, canvas preview, opacity variants, with dark and light theme blocks
2. **Update tailwind.config.js** — Reference CSS variables; add opacity variant color entries
3. **Migrate index.css hardcoded colors** — Replace all hex values with `var(--cc-*)` references
4. **Add AppearanceConfig to config system** — TypeScript types + Rust struct + defaults
5. **Create useTheme hook** — Reads config, resolves auto mode, applies data-theme attribute
6. **Create AppearanceSettings tab** — Settings UI with theme selector
7. **Handle MapLibre controls and third-party widget theming** — Conditional icon filter, DatePicker
8. **Migrate inline hex colors in TSX components** — SurveyLayer, SectionPreview, PlacementOverlay, GlobalSurveyLayer, GlobalViewMap, GridOverlay, DepthLegend, MapCanvas, etc. Exclude ExportPreview.
9. **Migrate Tailwind opacity modifier usage** — Replace all `bg-color/N` patterns with dedicated opacity tokens across 36+ component locations
10. **Update default color palettes for light theme** — DisplaySettings color pickers offer theme-appropriate defaults
11. **Add E2E tests for theme switching** — Verify theme attribute, CSS variables, Settings UI

## Files Modified

| File | Change |
|------|--------|
| `src/index.css` | Add CSS variable definitions (60+ tokens), migrate all hardcoded colors |
| `tailwind.config.js` | Reference CSS variables, add opacity variant entries |
| `src/types/config.ts` | Add `AppearanceConfig`, `ThemeMode` |
| `src-tauri/src/config/types.rs` | Add `AppearanceConfig` struct |
| `src-tauri/src/config/defaults.rs` | Add `Default` impl |
| `src/hooks/useTheme.ts` | New: theme resolution and application hook |
| `src/App.tsx` | Call `useTheme()` at app root |
| `src/components/Dialogs/settings/AppearanceSettings.tsx` | New: Appearance tab |
| `src/components/Dialogs/settings/SettingsDialog.tsx` | Add Appearance category |
| `src/components/Dialogs/settings/SettingsSidebar.tsx` | Add to sidebar |
| `src/components/Dialogs/settings/types.ts` | Add 'appearance' to SettingsCategory |
| `src/components/Map/SurveyLayer.tsx` | Replace 13 hardcoded colors with CSS variables |
| `src/components/Map/surveyLayer/features.ts` | Replace depth/station colors |
| `src/components/GlobalView/GlobalSurveyLayer.ts` | Replace 8 hardcoded colors |
| `src/components/GlobalView/GlobalViewMap.tsx` | Replace 8 hardcoded colors |
| `src/components/Dialogs/SectionPreview.tsx` | Replace 12 hardcoded colors |
| `src/components/Map/PlacementOverlay.tsx` | Replace 6 snap/anchor colors |
| `src/components/Map/MapCanvas.tsx` | Replace background default |
| `src/components/Map/GridOverlay.tsx` | Replace grid color default |
| `src/components/Map/DepthLegend.tsx` | Replace 3 depth/text colors |
| `src/components/common/SectionMetadataForm.tsx` | Replace placeholder color |
| `src/components/Dialogs/EditSectionDialog.tsx` | Replace default section color |
| `src/components/common/Button.tsx` | Replace opacity modifier usage |
| `src/components/common/ContextMenu.tsx` | Replace opacity modifier usage |
| `src/components/common/OfflineIndicator.tsx` | Replace opacity modifier usage |
| `src/components/SingleSystemView/DisplayMenu.tsx` | Replace opacity modifier usage |
| `src/components/SingleSystemView/UndoHistoryDropdown.tsx` | Replace opacity modifier usage |
| `src/components/Dialogs/ExportPreview.tsx` | Replace opacity modifier usage (keep render colors dark) |
| `e2e-playwright/tests/theme.spec.ts` | New: E2E tests for theme switching |

## Risks

- **Tailwind + CSS variables**: Opacity modifiers break. Mitigated by dedicated opacity tokens.
- **Large scope**: 60+ CSS variables, 20+ files to modify. Mitigated by systematic task breakdown and grep-driven migration.
- **Canvas rendering**: Components using `getComputedStyle` to read CSS variables in canvas contexts may need special handling.
- **MapLibre style expressions**: SurveyLayer uses MapLibre GL JS style expressions which may not support CSS variables directly. May need to read variables via JS and pass as values.
- **Third-party widget overrides**: DatePicker and MapLibre use `!important`. All must be converted.
