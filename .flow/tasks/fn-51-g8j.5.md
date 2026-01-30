# fn-51-g8j.5 Create useTheme hook for theme resolution and application

## Description

Create a React hook that reads the theme preference from config, resolves `auto` mode via OS preference, applies the resolved theme by setting `data-theme` attribute on `document.documentElement`, and **returns the resolved theme** so MapLibre and canvas components can react to theme changes.

## Files to create

- `src/hooks/useTheme.ts` — The theme hook

## Files to modify

- `src/App.tsx` — Call `useTheme()` at the app root level

## Implementation

### `src/hooks/useTheme.ts`

```typescript
import { useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import type { ThemeMode } from '../types/config';

export type ResolvedTheme = 'dark' | 'light';

/**
 * Resolves the effective theme from config preference.
 * - 'dark' / 'light' → used directly
 * - 'auto' → follows OS prefers-color-scheme
 *
 * Returns the resolved theme so MapLibre/canvas components can react.
 */
export function useTheme(): ResolvedTheme {
  const theme = useProjectStore(
    (state) => state.config?.appearance?.theme ?? 'dark'
  ) as ThemeMode;

  const [resolved, setResolved] = useState<ResolvedTheme>(() => {
    if (theme === 'auto') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
    return theme;
  });

  useEffect(() => {
    const apply = (r: ResolvedTheme) => {
      document.documentElement.dataset.theme = r;
      setResolved(r);
    };

    if (theme === 'auto') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      apply(mq.matches ? 'dark' : 'light');

      const handler = (e: MediaQueryListEvent) => {
        apply(e.matches ? 'dark' : 'light');
      };
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    } else {
      apply(theme);
    }
  }, [theme]);

  return resolved;
}
```

### Why return the resolved theme?

MapLibre GL JS does NOT read CSS variables. Colors are passed as literal values to `setPaintProperty()`, `addLayer()`, etc. When the theme changes, MapLibre layers must be explicitly re-styled. By returning `resolved`, any component can do:

```typescript
const resolvedTheme = useTheme();
// or for child components that don't call useTheme directly:
// read from a shared store/context
```

### Sharing resolved theme with child components

To avoid calling `useTheme()` in every component, store the resolved theme in the UI store:

```typescript
// In useTheme.ts — also set uiStore
import { useUIStore } from '../store/uiStore';

// Inside the apply function:
useUIStore.getState().setResolvedTheme(r);
```

Then MapLibre components read from `useUIStore`:
```typescript
const resolvedTheme = useUIStore((s) => s.resolvedTheme);
```

### `src/App.tsx`

Add `useTheme()` call at the top of the App component:

```typescript
import { useTheme } from './hooks/useTheme';

function App() {
  useTheme(); // applies data-theme, stores resolved theme
  // ... rest of component
}
```

### UI Store addition

Add to `src/store/uiStore.ts`:
```typescript
resolvedTheme: 'dark' | 'light';
setResolvedTheme: (theme: 'dark' | 'light') => void;
```

### Key behaviors

1. Default to `'dark'` if config not yet loaded (null-safe with `?? 'dark'`)
2. For `'auto'` mode, listen for OS theme changes via `matchMedia`
3. Clean up media query listener on unmount or theme change
4. Set `data-theme` attribute which CSS variable selectors respond to
5. Return resolved theme for MapLibre/canvas components
6. Store resolved theme in uiStore for child component access
7. No flash of wrong theme — dark is default in CSS (`:root` = dark)

## Files also modified

- `src/store/uiStore.ts` — Add `resolvedTheme` state and `setResolvedTheme` action

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
