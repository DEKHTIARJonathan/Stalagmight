import { useEffect } from 'react';
import { getUiScale, setUiScale, UI_SCALE_STEP, UI_SCALE_DEFAULT } from '../utils/uiScale';

/**
 * Whole-UI zoom via Ctrl+= / Ctrl+- / Ctrl+0, persisted across launches.
 *
 * Uses Tauri's native webview page zoom (correct hit-testing, unlike CSS `zoom`).
 * The map's own `=`/`-` zoom is untouched — those are bound without a modifier,
 * so Ctrl-modified presses fall through to this handler. Requires the
 * `core:webview:allow-set-webview-zoom` capability. The Settings → Display
 * "UI scale" slider drives the same {@link setUiScale}.
 */
export function useUiScale(): void {
  useEffect(() => {
    // Restore the saved scale on startup (webview zoom resets to 1 each launch).
    setUiScale(getUiScale());

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
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
