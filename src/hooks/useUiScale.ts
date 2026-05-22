import { useEffect } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';

const STORAGE_KEY = 'ui-scale';
const MIN = 0.5;
const MAX = 3.0;
const STEP = 0.1;

function clamp(value: number): number {
  return Math.min(MAX, Math.max(MIN, Math.round(value * 10) / 10));
}

function readScale(): number {
  const raw = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(raw) && raw > 0 ? clamp(raw) : 1;
}

/**
 * Whole-UI zoom via Ctrl+= / Ctrl+- / Ctrl+0, persisted across launches.
 *
 * Uses Tauri's native webview page zoom (correct hit-testing, unlike CSS `zoom`).
 * The map's own `=`/`-` zoom is untouched — those are bound without a modifier,
 * so Ctrl-modified presses fall through to this handler. Requires the
 * `core:webview:allow-set-webview-zoom` capability.
 */
export function useUiScale(): void {
  useEffect(() => {
    const webview = getCurrentWebview();

    const apply = (scale: number) => {
      localStorage.setItem(STORAGE_KEY, String(scale));
      void webview.setZoom(scale).catch(() => {
        /* zoom unsupported on this platform — ignore */
      });
    };

    // Restore the saved scale on startup (webview zoom resets to 1 each launch).
    apply(readScale());

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

      let next: number | null = null;
      if (event.key === '=' || event.key === '+') next = readScale() + STEP;
      else if (event.key === '-' || event.key === '_') next = readScale() - STEP;
      else if (event.key === '0') next = 1;
      if (next === null) return;

      event.preventDefault();
      apply(clamp(next));
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
