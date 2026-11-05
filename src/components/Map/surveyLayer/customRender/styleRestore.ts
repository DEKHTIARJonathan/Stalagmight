/**
 * Re-adding custom layers after MapLibre rebuilds the style (#606).
 *
 * MapLibre 6 rebuilds the whole style from `style.serialize()` on two paths:
 * a WebGL context loss + restore (`Map._contextLost` / `_contextRestored`), and a
 * worker restart (`Map._handleWorkersRestarted`, which `watchWorkers()` triggers
 * on `visibilitychange -> visible` when the workers miss a ping). Custom layers
 * cannot be serialized, so both paths drop every one of them. Both end by firing
 * `webglcontextrestored` synchronously, while the rebuilt style loads one frame
 * later (`setStyle` -> `loadJSON` -> `frameAsync`) and announces it with
 * `style.load`. Only then can layers be added again.
 *
 * The two paths differ in what they leave behind: a context loss destroys the
 * old style, which runs each custom layer's `onRemove` against the dead context;
 * a worker restart keeps the same context and never calls `onRemove`, so the
 * layer still owns live GL objects. {@link reAddCustomLayer} frees first (our
 * layers' `onRemove` is idempotent), so `onAdd` always starts clean.
 */
import type { CustomLayerInterface, Map as MaplibreMap } from 'maplibre-gl';

/** A custom layer that can report a failed `onAdd`. */
export interface RestorableCustomLayer extends CustomLayerInterface {
  isDisabled(): boolean;
}

/**
 * Run `reattach` once the style rebuilt by a context restore or a worker restart
 * has loaded. Returns an unsubscribe.
 */
export function onStyleRestored(map: MaplibreMap, reattach: () => void): () => void {
  let pending = false;
  const onLoad = (): void => {
    pending = false;
    reattach();
  };
  const onRestored = (): void => {
    if (pending) return;
    pending = true;
    map.once('style.load', onLoad);
  };
  map.on('webglcontextrestored', onRestored);
  return () => {
    map.off('webglcontextrestored', onRestored);
    if (pending) map.off('style.load', onLoad);
  };
}

/**
 * Add `layer` back to the rebuilt style with fresh GL resources. No-op when the
 * style still holds it. Returns false when the layer could not start again.
 */
export function reAddCustomLayer(
  map: MaplibreMap,
  layer: RestorableCustomLayer,
  beforeId?: string,
): boolean {
  if (map.getLayer(layer.id)) return true;
  layer.onRemove?.(map, map.painter.context.gl);
  map.addLayer(layer, beforeId);
  return !layer.isDisabled();
}
