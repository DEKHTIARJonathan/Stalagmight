/**
 * Bring the survey map's custom WebGL layers back after a WebGL context loss
 * (#576 D38).
 *
 * A GPU reset, a driver crash, some sleep/resume cycles and WebKit memory
 * pressure all lose the context. maplibre-gl 5.16 then serializes the style
 * WITHOUT its custom layers (`_serializedAllLayers` skips `type === 'custom'`),
 * destroys it (custom layers get `onRemove`) and, on `webglcontextrestored`,
 * re-applies only that serialized style. It never re-adds a custom layer - it
 * warns "cannot be restored after WebGL context loss. You will need to re-add it
 * manually" - so every survey layer (geometry, labels, measured-path tint, drag
 * ghost) stayed gone until the map was remounted.
 *
 * This module re-adds them. The layer objects survive the loss with their data
 * (their `onRemove` only drops GL handles), so re-adding the SAME object makes
 * MapLibre run its `onAdd` again, which recompiles the programs and re-uploads
 * the buffers from that data on the new context.
 *
 * Z-order: the layer order is snapshotted just before MapLibre tears the style
 * down - in the capture phase on the canvas container, which runs before
 * MapLibre's own `webglcontextlost` listener on the canvas itself - and each
 * custom layer is re-inserted before the layer that followed it then
 * ({@link reattachPlan}).
 */
import type { Map as MaplibreMap } from 'maplibre-gl';

/** A controller that owns one custom layer and can re-add it. */
export interface ReattachableLayer {
  /** The custom layer's id on the map. */
  readonly layerId: string;
  /**
   * Re-add the live layer object before `beforeId` (undefined: on top). No-op
   * when the controller has nothing drawing.
   */
  reattach(beforeId: string | undefined): void;
}

/**
 * The order to re-add `customIds` in, each with the layer to insert it before,
 * so the stack ends up exactly as `order` (the pre-loss order, bottom to top).
 *
 * Works top-down: when a custom layer is placed, every layer that followed it is
 * either a stock layer the restored style already has, or a custom layer placed
 * earlier in this plan, so "the first follower that is on the map" is its true
 * successor. Custom ids absent from `order` (nothing drawing) are skipped. Pure.
 */
export function reattachPlan(
  order: readonly string[],
  customIds: readonly string[],
  onMap: (id: string) => boolean,
): Array<{ id: string; beforeId: string | undefined }> {
  const custom = new Set(customIds);
  const placed = new Set<string>();
  const plan: Array<{ id: string; beforeId: string | undefined }> = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    if (!custom.has(id)) continue;
    let beforeId: string | undefined;
    for (let j = i + 1; j < order.length; j++) {
      const next = order[j]!;
      if (placed.has(next) || (!custom.has(next) && onMap(next))) {
        beforeId = next;
        break;
      }
    }
    plan.push({ id, beforeId });
    placed.add(id);
  }
  return plan;
}

export interface GlContextRecoveryOptions {
  /** The custom layers to bring back, read when the context comes back. */
  layers: () => readonly ReattachableLayer[];
  /**
   * Runs just before MapLibre serializes and destroys the style, while it is
   * still alive - the last chance to put style state right that should survive
   * into the restored copy.
   */
  beforeLoss?: () => void;
  /** Runs once the custom layers are back: replay what changed meanwhile. */
  afterRestore: () => void;
}

/**
 * Watch `map` for a WebGL context loss and restore the custom layers when the
 * context comes back. Returns the detach function.
 */
export function watchGlContextLoss(map: MaplibreMap, opts: GlContextRecoveryOptions): () => void {
  const container = map.getCanvasContainer();
  let order: string[] | null = null;
  let lost = false;
  let pendingStyleLoad: (() => void) | null = null;

  const snapshot = (): void => {
    try {
      order = map.getLayersOrder();
    } catch {
      order = null; // no style to snapshot: nothing custom is on it either
    }
    opts.beforeLoss?.();
  };

  const reattach = (): void => {
    pendingStyleLoad = null;
    if (!lost) return;
    lost = false;
    const owners = new Map(opts.layers().map((l) => [l.layerId, l]));
    // Without a snapshot, fall back to each layer's insertion order on top.
    const plan = order
      ? reattachPlan(order, [...owners.keys()], (id) => Boolean(map.getLayer(id)))
      : [...owners.keys()].map((id) => ({ id, beforeId: undefined }));
    order = null;
    for (const { id, beforeId } of plan) owners.get(id)?.reattach(beforeId);
    opts.afterRestore();
    map.triggerRepaint();
  };

  const onLost = (): void => {
    lost = true;
  };

  // MapLibre restores by re-applying the serialized style, which loads on the
  // NEXT frame; adding a layer before that throws "Style is not done loading".
  const onRestored = (): void => {
    if (!lost || pendingStyleLoad) return;
    pendingStyleLoad = reattach;
    map.once('style.load', reattach);
  };

  container.addEventListener('webglcontextlost', snapshot, true);
  map.on('webglcontextlost', onLost);
  map.on('webglcontextrestored', onRestored);

  return () => {
    container.removeEventListener('webglcontextlost', snapshot, true);
    map.off('webglcontextlost', onLost);
    map.off('webglcontextrestored', onRestored);
    if (pendingStyleLoad) map.off('style.load', pendingStyleLoad);
    pendingStyleLoad = null;
  };
}
