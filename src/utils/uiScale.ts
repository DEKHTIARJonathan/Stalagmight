import { getCurrentWebview } from '@tauri-apps/api/webview';
import { clamp } from './clamp';

export const UI_SCALE_MIN = 0.5;
export const UI_SCALE_MAX = 3.0;
export const UI_SCALE_STEP = 0.1;
export const UI_SCALE_DEFAULT = 1.0;

const STORAGE_KEY = 'ui-scale';

/** Dispatched on `window` whenever the UI scale changes, so open UI can sync. */
export const UI_SCALE_EVENT = 'ui-scale-change';

export function clampUiScale(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return clamp(rounded, UI_SCALE_MIN, UI_SCALE_MAX);
}

/** Current UI scale from storage, or the default if unset/invalid. */
export function getUiScale(): number {
  const raw = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampUiScale(raw) : UI_SCALE_DEFAULT;
}

/**
 * Persist and apply a UI scale via the webview's native page zoom, then notify
 * listeners (e.g. the Settings slider) so they stay in sync. Returns the clamped
 * value that was applied.
 */
export function setUiScale(value: number): number {
  const scale = clampUiScale(value);
  localStorage.setItem(STORAGE_KEY, String(scale));
  void getCurrentWebview()
    .setZoom(scale)
    .catch(() => {
      /* zoom unsupported on this platform — ignore */
    });
  window.dispatchEvent(new CustomEvent(UI_SCALE_EVENT, { detail: scale }));
  return scale;
}
