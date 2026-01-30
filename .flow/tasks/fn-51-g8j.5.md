# fn-51-g8j.5 Create useTheme hook for theme resolution and application

## Description

Create a React hook that reads the theme preference from config, resolves `auto` mode via OS preference, applies the resolved theme by setting `data-theme` attribute on `document.documentElement`, and stores the resolved theme in uiStore so MapLibre and canvas components can react to theme changes.

**Size:** M
**Files:**
- `src/hooks/useTheme.ts` (new)
- `src/App.tsx`
- `src/store/uiStore.ts`

## Approach

- Hook reads theme from `useProjectStore().config?.appearance?.theme ?? 'dark'`
- For `'auto'` mode, listen to `window.matchMedia('(prefers-color-scheme: dark)')` and update on OS changes
- Set `document.documentElement.dataset.theme` to resolved value
- Store resolved theme in `uiStore` via `setResolvedTheme()` — this is how MapLibre components subscribe to theme changes
- Call `useTheme()` at top of `App` component
- Default to `'dark'` when config is null (async loading)

## Key context

- MapLibre GL JS does NOT read CSS variables. The resolved theme in uiStore is the trigger for MapCanvas to call `surveyLayer.applyThemeColors()` (wired in task 10)
- No flash of wrong theme because `:root` CSS defaults to dark (task 1) and hook defaults to `'dark'`
- Media query listener must be cleaned up on unmount or theme change

## Acceptance

- [ ] `useTheme` hook exists at `src/hooks/useTheme.ts`
- [ ] Hook reads theme from `useProjectStore().config.appearance.theme`
- [ ] Hook returns `ResolvedTheme` ('dark' | 'light')
- [ ] `data-theme="dark"` set when theme is `'dark'`
- [ ] `data-theme="light"` set when theme is `'light'`
- [ ] `data-theme` follows OS preference when theme is `'auto'`
- [ ] OS preference changes are tracked reactively (media query listener)
- [ ] Listener cleaned up on unmount
- [ ] `resolvedTheme` stored in uiStore for child components
- [ ] `useTheme()` called in App.tsx root
- [ ] No flash of incorrect theme on load (dark is CSS default)
- [ ] `pnpm tsc --noEmit` passes

## Done summary

(To be filled on completion)

## Evidence

(To be filled on completion)
