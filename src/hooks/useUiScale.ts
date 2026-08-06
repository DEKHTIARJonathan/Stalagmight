import { useEffect } from 'react';
import {
  getUiScale,
  refreshUiScale,
  setUiScale,
  UI_SCALE_STEP,
  UI_SCALE_DEFAULT,
} from '../utils/uiScale';

/**
 * Whole-UI zoom via Ctrl+= / Ctrl+- / Ctrl+0, persisted across launches.
 *
 * Uses Tauri's native webview page zoom (correct hit-testing, unlike CSS `zoom`).
 * The map's own `=`/`-` zoom is untouched - those are bound without a modifier,
 * so Ctrl-modified presses fall through to this handler. Requires the
 * `core:webview:allow-set-webview-zoom` capability. The Settings → Display
 * "UI scale" slider drives the same {@link setUiScale}.
 *
 * What actually reaches the webview is the preference capped to the window, so a
 * high scale in a small window cannot shrink the CSS viewport below the layout's
 * floor (#429). That cap is a function of the window size, so it is recomputed on
 * every resize - and releases again, back up to the untouched preference, as soon
 * as the window can carry it.
 */
export function useUiScale(): void {
  useEffect(() => {
    // Restore the saved scale on startup (webview zoom resets to 1 each launch).
    refreshUiScale();

    const onResize = () => refreshUiScale();
    window.addEventListener('resize', onResize);

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

      let next: number | null = null;
      if (event.key === '=' || event.key === '+') next = getUiScale() + UI_SCALE_STEP;
      else if (event.key === '-' || event.key === '_') next = getUiScale() - UI_SCALE_STEP;
      else if (event.key === '0') next = UI_SCALE_DEFAULT;
      if (next === null) return;

      event.preventDefault();
      setUiScale(next);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, []);
}
