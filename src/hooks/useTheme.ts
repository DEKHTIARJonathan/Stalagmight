import { useLayoutEffect, useRef } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useUIStore, type ResolvedTheme } from '../store/uiStore';
import type { ColorTheme } from '../types/config';

/**
 * Subscribe to a MediaQueryList change event, with fallback for older
 * WebView implementations that only support the deprecated addListener API.
 * Returns a cleanup function to remove the listener.
 */
function subscribeMediaQuery(
  mql: MediaQueryList,
  handler: (e: MediaQueryListEvent) => void
): () => void {
  // Modern browsers and Tauri WebView2 support addEventListener.
  // Cast to unknown first to allow runtime check for older WebViews
  // that only expose the deprecated addListener/removeListener API.
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }
  // Fallback for older WebView/browser implementations
  const legacy = mql as unknown as {
    addListener: (cb: (e: MediaQueryListEvent) => void) => void;
    removeListener: (cb: (e: MediaQueryListEvent) => void) => void;
  };
  legacy.addListener(handler);
  return () => legacy.removeListener(handler);
}

/**
 * Resolve a ColorTheme value ('dark' | 'light') to a ResolvedTheme.
 */
function colorThemeToResolved(ct: ColorTheme): ResolvedTheme {
  // Each ColorTheme maps 1:1 to a ResolvedTheme (data-theme attribute value)
  return ct as ResolvedTheme;
}

/**
 * Hook that reads the theme preference from config, resolves 'auto' mode
 * via OS prefers-color-scheme, looks up the per-mode color theme, applies
 * the resolved color theme by setting data-theme attribute on
 * document.documentElement, and stores the resolved theme in uiStore for
 * MapLibre and canvas components.
 *
 * Uses useLayoutEffect so the data-theme attribute is committed before
 * paint, preventing a flash of the wrong theme.
 *
 * Call this once at the top level of the App component.
 *
 * @returns The last resolved theme from uiStore ('dark' | 'light').
 *   Note: on the very first render the store value may be the initial
 *   default ('dark') until the layout effect runs. This is intentional --
 *   the CSS :root defaults to dark so there is no visual mismatch.
 */
export function useTheme(): ResolvedTheme {
  const configAppearance = useProjectStore(
    (s) => s.config?.appearance ?? null
  );
  const themePreview = useUIStore((s) => s.themePreview);
  const setResolvedTheme = useUIStore((s) => s.setResolvedTheme);
  const resolvedTheme = useUIStore((s) => s.resolvedTheme);

  // Use preview override when Settings dialog is live-previewing a theme
  const appearance = themePreview ?? configAppearance;
  const themePreference = appearance?.theme ?? 'dark';
  const dayColorTheme: ColorTheme = appearance?.day_color_theme ?? 'light';
  const nightColorTheme: ColorTheme = appearance?.night_color_theme ?? 'dark';

  // Track media query listener cleanup
  const mediaListenerCleanupRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
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

    /**
     * Given a resolved mode ('dark' = night, 'light' = day), look up the
     * configured color theme for that mode and apply it.
     */
    function applyForMode(mode: 'dark' | 'light') {
      const colorTheme = mode === 'light' ? dayColorTheme : nightColorTheme;
      applyTheme(colorThemeToResolved(colorTheme));
    }

    if (themePreference === 'auto') {
      // Guard against environments where matchMedia is unavailable
      if (typeof window.matchMedia !== 'function') {
        applyForMode('dark');
        return;
      }

      // Resolve from OS preference
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const resolvedMode: 'dark' | 'light' = mediaQuery.matches ? 'dark' : 'light';
      applyForMode(resolvedMode);

      // Listen for OS theme changes
      const handler = (e: MediaQueryListEvent) => {
        const newMode: 'dark' | 'light' = e.matches ? 'dark' : 'light';
        applyForMode(newMode);
      };
      mediaListenerCleanupRef.current = subscribeMediaQuery(mediaQuery, handler);
    } else {
      // Direct theme: 'dark' or 'light'
      const mode: 'dark' | 'light' = themePreference === 'light' ? 'light' : 'dark';
      applyForMode(mode);
    }

    return () => {
      if (mediaListenerCleanupRef.current) {
        mediaListenerCleanupRef.current();
        mediaListenerCleanupRef.current = null;
      }
    };
  }, [themePreference, dayColorTheme, nightColorTheme, setResolvedTheme]);

  return resolvedTheme;
}
