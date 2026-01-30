# Theme Infrastructure: CSS Variables, ThemeProvider, Dark+Light Themes

## Problem

CaveChef has a single hardcoded dark theme with all colors as literal hex values spread across `tailwind.config.js`, `src/index.css`, and inline component styles. There is no mechanism for users to switch themes, no CSS variable system, and no infrastructure for future high-contrast or custom themes.

## Goals

1. Migrate all hardcoded UI chrome colors to CSS custom properties (`--cc-*` prefix)
2. Ship two working themes: **dark** (existing palette) and **light** (inspired by `brand_tokens.css`)
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
- `color-scheme` CSS property on root (affects native select/date inputs)
- MapLibre icon inversion filter made conditional on theme
- Theme influences default color palettes offered in display settings color pickers

### Out of scope
- High-contrast theme (v2.0)
- Per-project theme settings (theme is global/app-level only)
- Section colors, map grid color, depth gradient colors (remain per-project display settings)

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| CSS variables (`--cc-*`) over Tailwind `dark:` prefix | More flexible for future themes; works with arbitrary values; single source of truth |
| `[data-theme]` attribute selector | Explicit control, works without media query, composable with `prefers-color-scheme` for auto mode |
| App-level config, not per-project | Theme is user preference, not project data |
| Dark as default | Existing users see no change on update |
| Full migration in one pass | No mixed hardcoded/variable state; clean cut |
| Light theme derived from brand_tokens.css | Leverages existing brand palette; warm tones differentiate from generic light themes |

## Technical Approach

### CSS Variable Definitions

Define all tokens in `src/index.css` under theme selectors:

```css
:root, [data-theme="dark"] {
  --cc-background: #1a1a2e;
  --cc-panel: #16213e;
  --cc-border: #0f3460;
  --cc-text-primary: #f5f5f5;
  --cc-text-secondary: #a0a0a0;
  --cc-accent: #4ecdc4;
  --cc-accent-on: #1a1a2e;       /* text on accent bg */
  --cc-warning: #ffcb77;
  --cc-error: #ff6b6b;
  --cc-success: #95e1d3;
  --cc-hover: rgba(78, 205, 196, 0.1);
  --cc-focus-ring: #4ecdc4;
  --cc-scrollbar-track: #16213e;
  --cc-scrollbar-thumb: #0f3460;
  --cc-scrollbar-hover: #4ecdc4;
  --cc-input-bg: #16213e;
  --cc-input-border: #0f3460;
  --cc-outside-month: #666;
  color-scheme: dark;
}

[data-theme="light"] {
  --cc-background: #f5f0e8;       /* warm limestone-inspired */
  --cc-panel: #ffffff;
  --cc-border: #d4c5a9;
  --cc-text-primary: #1a120b;     /* basalt dark */
  --cc-text-secondary: #6b5b4a;
  --cc-accent: #3a8a82;           /* darker teal for contrast on light */
  --cc-accent-on: #ffffff;
  --cc-warning: #c4901a;
  --cc-error: #c44040;
  --cc-success: #2a7a6a;
  --cc-hover: rgba(58, 138, 130, 0.08);
  --cc-focus-ring: #3a8a82;
  --cc-scrollbar-track: #ebe4d8;
  --cc-scrollbar-thumb: #c1a07a;
  --cc-scrollbar-hover: #3a8a82;
  --cc-input-bg: #ffffff;
  --cc-input-border: #d4c5a9;
  --cc-outside-month: #aaa;
  color-scheme: light;
}
```

### Tailwind Integration

Update `tailwind.config.js` to reference CSS variables:

```js
colors: {
  background: 'var(--cc-background)',
  panel: 'var(--cc-panel)',
  border: 'var(--cc-border)',
  'text-primary': 'var(--cc-text-primary)',
  // ... etc
}
```

### Config System

**TypeScript** (`src/types/config.ts`):
```typescript
export type ThemeMode = 'dark' | 'light' | 'auto';
export interface AppearanceConfig {
  theme: ThemeMode;
}
```

**Rust** (`src-tauri/src/config/types.rs`):
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppearanceConfig {
    #[serde(default = "default_theme")]
    pub theme: String, // "dark" | "light" | "auto"
}
```

### Theme Application

A `useTheme` hook reads `config.appearance.theme` from the project store, resolves `auto` via `window.matchMedia('(prefers-color-scheme: dark)')`, and sets `document.documentElement.dataset.theme` accordingly.

### Settings UI

New `AppearanceSettings.tsx` tab following existing `SettingsCategoryProps` pattern with a theme selector (radio group or select).

## Task Breakdown

1. **Define CSS variable tokens and theme definitions** — Add `--cc-*` variables to `index.css` with dark and light theme blocks
2. **Update tailwind.config.js** — Reference CSS variables instead of hardcoded hex values
3. **Migrate index.css hardcoded colors** — Replace all hex values in scrollbar, input, checkbox, table, focus, DatePicker, and MapLibre styles with `var(--cc-*)` references
4. **Add AppearanceConfig to config system** — TypeScript types, Rust struct + defaults, wire into Config
5. **Create useTheme hook** — Reads config, resolves auto mode, applies `data-theme` attribute and `color-scheme` property
6. **Create AppearanceSettings tab** — Settings UI with theme selector, wire into SettingsDialog and SettingsSidebar
7. **Handle MapLibre controls theming** — Make icon inversion filter conditional; adjust control styles for light theme
8. **Update default color palettes for light theme** — Ensure DisplaySettings color pickers offer theme-appropriate defaults
9. **Add tests** — E2E test for theme switching, verify CSS variables applied correctly

## Files Modified

| File | Change |
|------|--------|
| `src/index.css` | Add CSS variable definitions, migrate all hardcoded colors |
| `tailwind.config.js` | Reference CSS variables |
| `src/types/config.ts` | Add `AppearanceConfig`, `ThemeMode` |
| `src-tauri/src/config/types.rs` | Add `AppearanceConfig` struct |
| `src-tauri/src/config/defaults.rs` | Add `Default` impl |
| `src/hooks/useTheme.ts` | New: theme resolution and application hook |
| `src/App.tsx` | Call `useTheme()` at app root |
| `src/components/Dialogs/settings/AppearanceSettings.tsx` | New: Appearance tab |
| `src/components/Dialogs/settings/SettingsDialog.tsx` | Add Appearance category |
| `src/components/Dialogs/settings/SettingsSidebar.tsx` | Add to sidebar |
| `src/components/Dialogs/settings/types.ts` | Add 'appearance' to SettingsCategory |

## Risks

- **Tailwind + CSS variables**: CSS variables in Tailwind colors lose opacity modifier support (`bg-background/50` won't work). Mitigation: define separate `--cc-hover` etc. tokens for common opacity variants.
- **Third-party widget overrides**: DatePicker and MapLibre use `!important` overrides that must all be converted. Mitigation: systematic grep for all hex values in index.css.
- **Component inline styles**: Some components may use hardcoded colors in JSX `style` props. Mitigation: grep for hex color patterns in `.tsx` files.
