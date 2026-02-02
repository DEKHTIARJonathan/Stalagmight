import { useLayoutEffect, useRef } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useUIStore, type ResolvedTheme } from '../store/uiStore';

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
 * Hook that reads the theme preference from config, resolves 'auto' mode
 * via OS prefers-color-scheme, applies the resolved theme by setting
 * data-theme attribute on document.documentElement, and stores the
 * resolved theme in uiStore for MapLibre and canvas components.
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
  const configTheme = useProjectStore(
    (s) => s.config?.appearance?.theme ?? 'dark'
  );
  const themePreview = useUIStore((s) => s.themePreview);
  const setResolvedTheme = useUIStore((s) => s.setResolvedTheme);
  const resolvedTheme = useUIStore((s) => s.resolvedTheme);

  // Use preview override when Settings dialog is live-previewing a theme
  const themePreference = themePreview ?? configTheme;

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

    if (themePreference === 'auto') {
      // Guard against environments where matchMedia is unavailable
      if (typeof window.matchMedia !== 'function') {
        applyTheme('dark');
        return;
      }

      // Resolve from OS preference
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const resolved: ResolvedTheme = mediaQuery.matches ? 'dark' : 'light';
      applyTheme(resolved);

      // Listen for OS theme changes
      const handler = (e: MediaQueryListEvent) => {
        const newTheme: ResolvedTheme = e.matches ? 'dark' : 'light';
        applyTheme(newTheme);
      };
      mediaListenerCleanupRef.current = subscribeMediaQuery(mediaQuery, handler);
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
