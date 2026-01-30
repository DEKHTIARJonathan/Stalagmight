import { useEffect, useRef } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useUIStore, type ResolvedTheme } from '../store/uiStore';

/**
 * Hook that reads the theme preference from config, resolves 'auto' mode
 * via OS prefers-color-scheme, applies the resolved theme by setting
 * data-theme attribute on document.documentElement, and stores the
 * resolved theme in uiStore for MapLibre and canvas components.
 *
 * Call this once at the top level of the App component.
 *
 * @returns The resolved theme ('dark' | 'light')
 */
export function useTheme(): ResolvedTheme {
  const themePreference = useProjectStore(
    (s) => s.config?.appearance?.theme ?? 'dark'
  );
  const setResolvedTheme = useUIStore((s) => s.setResolvedTheme);
  const resolvedTheme = useUIStore((s) => s.resolvedTheme);

  // Track media query listener cleanup
  const mediaListenerCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Clean up any previous media query listener
    if (mediaListenerCleanupRef.current) {
      mediaListenerCleanupRef.current();
      mediaListenerCleanupRef.current = null;
    }

    /**
     * Apply the given resolved theme: set data-theme attribute on the
     * document root and update uiStore.
     */
    function applyTheme(theme: ResolvedTheme) {
      document.documentElement.dataset.theme = theme;
      setResolvedTheme(theme);
    }

    if (themePreference === 'auto') {
      // Resolve from OS preference
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const resolved: ResolvedTheme = mediaQuery.matches ? 'dark' : 'light';
      applyTheme(resolved);

      // Listen for OS theme changes
      const handler = (e: MediaQueryListEvent) => {
        const newTheme: ResolvedTheme = e.matches ? 'dark' : 'light';
        applyTheme(newTheme);
      };
      mediaQuery.addEventListener('change', handler);

      mediaListenerCleanupRef.current = () => {
        mediaQuery.removeEventListener('change', handler);
      };
    } else {
      // Direct theme: 'dark' or 'light'
      const resolved: ResolvedTheme = themePreference === 'light' ? 'light' : 'dark';
      applyTheme(resolved);
    }

    return () => {
      if (mediaListenerCleanupRef.current) {
        mediaListenerCleanupRef.current();
        mediaListenerCleanupRef.current = null;
      }
    };
  }, [themePreference, setResolvedTheme]);

  return resolvedTheme;
}
