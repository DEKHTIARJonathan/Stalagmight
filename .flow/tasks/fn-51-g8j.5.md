# fn-51-g8j.5 Create useTheme hook for theme resolution and application

## Description

Create a React hook that reads the theme preference from config, resolves `auto` mode via OS preference, and applies the resolved theme by setting `data-theme` attribute on `document.documentElement`.

## Files to create

- `src/hooks/useTheme.ts` — The theme hook

## Files to modify

- `src/App.tsx` — Call `useTheme()` at the app root level

## Implementation

### `src/hooks/useTheme.ts`

```typescript
import { useEffect } from 'react';
import { useProjectStore } from '../store/projectStore';
import type { ThemeMode } from '../types/config';

/**
 * Resolves the effective theme from config preference.
 * - 'dark' / 'light' → used directly
 * - 'auto' → follows OS prefers-color-scheme
 */
export function useTheme(): void {
  const theme = useProjectStore(
    (state) => state.config?.appearance?.theme ?? 'dark'
  ) as ThemeMode;

  useEffect(() => {
    const applyTheme = (resolved: 'dark' | 'light') => {
      document.documentElement.dataset.theme = resolved;
    };

    if (theme === 'auto') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      applyTheme(mq.matches ? 'dark' : 'light');

      const handler = (e: MediaQueryListEvent) => {
        applyTheme(e.matches ? 'dark' : 'light');
      };
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    } else {
      applyTheme(theme);
    }
  }, [theme]);
}
```

### `src/App.tsx`

Add `useTheme()` call at the top of the App component:

```typescript
import { useTheme } from './hooks/useTheme';

function App() {
  useTheme();
  // ... rest of component
}
```

### Key behaviors

1. Default to `'dark'` if config not yet loaded (null-safe with `?? 'dark'`)
2. For `'auto'` mode, listen for OS theme changes via `matchMedia`
3. Clean up media query listener on unmount or theme change
4. Set `data-theme` attribute which CSS variable selectors respond to
5. No flash of wrong theme — dark is default in CSS (`:root` = dark)

## Acceptance

- [ ] `useTheme` hook exists at `src/hooks/useTheme.ts`
- [ ] Hook reads theme from `useProjectStore().config.appearance.theme`
- [ ] `data-theme="dark"` set when theme is `'dark'`
- [ ] `data-theme="light"` set when theme is `'light'`
- [ ] `data-theme` follows OS preference when theme is `'auto'`
- [ ] OS preference changes are tracked reactively (media query listener)
- [ ] Listener cleaned up on unmount
- [ ] `useTheme()` called in App.tsx root
- [ ] No flash of incorrect theme on load (dark is CSS default)
- [ ] `pnpm tsc --noEmit` passes
