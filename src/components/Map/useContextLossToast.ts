import { useEffect, useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { useUIStore } from '../../store/uiStore';
import { TOAST_KEYS } from '../../utils/toastKeys';
import { renderFatalMessage } from './surveyLayer/mapErrors';

/**
 * How long a lost WebGL context gets to come back before the user is told
 * (#576 D38-LOST). A browser that restores does so within a frame or two of
 * the GPU coming back; one that has given up never fires the restore at all.
 */
export const CONTEXT_RESTORE_GRACE_MS = 5000;

export interface ContextRestoreWatch {
  graceMs: number;
  /** The context was lost and has not come back within `graceMs`. */
  onUnrecovered: () => void;
  /** It came back after `onUnrecovered` ran (or the watch ended while it was reported). */
  onRecovered: () => void;
}

/**
 * Watch `map` for a WebGL context that is lost and NOT restored. The custom
 * layers come back by themselves when it is restored (glContextRecovery.ts), so
 * a loss alone is nothing to report; a restore that never arrives leaves the
 * survey blank for good, and that the user has to hear about. Returns the detach,
 * which also takes back a report still standing.
 */
export function watchContextRestore(map: MaplibreMap, opts: ContextRestoreWatch): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reported = false;
  const onLost = (): void => {
    if (timer !== null || reported) return;
    timer = setTimeout(() => {
      timer = null;
      reported = true;
      opts.onUnrecovered();
    }, opts.graceMs);
  };
  const onRestored = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!reported) return;
    reported = false;
    opts.onRecovered();
  };
  map.on('webglcontextlost', onLost);
  map.on('webglcontextrestored', onRestored);
  return () => {
    map.off('webglcontextlost', onLost);
    map.off('webglcontextrestored', onRestored);
    onRestored();
  };
}

/**
 * The lost-context notice for one map (survey map, Global View): after
 * {@link CONTEXT_RESTORE_GRACE_MS} without a restore, an error toast with a
 * "Reload map" action that rebuilds the map on a new WebGL context
 * (`onReload`, which remounts the map). The toast stays until the context comes
 * back by itself, the map is rebuilt or left, or the user dismisses it.
 */
export function useContextLossToast(
  map: RefObject<MaplibreMap | null>,
  mapLoaded: boolean,
  onReload: () => void,
): void {
  const { t } = useTranslation();
  const onReloadRef = useRef(onReload);
  useEffect(() => {
    onReloadRef.current = onReload;
  }, [onReload]);

  useEffect(() => {
    const current = map.current;
    if (!current || !mapLoaded) return undefined;
    return watchContextRestore(current, {
      graceMs: CONTEXT_RESTORE_GRACE_MS,
      onUnrecovered: () =>
        useUIStore.getState().showToast(renderFatalMessage('webgl-context-lost'), TOAST_KEYS.RENDER_CONTEXT_LOST, 'error', {
          persistent: true,
          action: {
            label: t('map.contextLost.reload'),
            onAction: () => onReloadRef.current(),
            testId: 'map-context-lost-reload',
          },
        }),
      onRecovered: () => useUIStore.getState().dismissToastByKey(TOAST_KEYS.RENDER_CONTEXT_LOST),
    });
  }, [map, mapLoaded, t]);
}
