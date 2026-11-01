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
 * custom layer is re-inserted before the first layer that followed it then and
 * is on the map now ({@link reattachInOrder}).
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
 * Re-add the custom layers `owners` holds so the stack ends up as `order` (the
 * pre-loss order, bottom to top).
 *
 * Works top-down, and picks each layer's insertion point against the LIVE map
 * (`onMap`) at the moment it is re-added: the first layer that followed it in
 * `order` and is on the map now. Everything above it has been dealt with by then,
 * so that is its true successor - including when a custom layer above it did not
 * land (its controller had nothing to draw any more, or the re-add failed and it
 * tore itself down). Trusting the plan instead put the layer below before one that
 * is not on the map, which MapLibre refuses ("Cannot add layer ... before
 * non-existing layer"), so one failed re-add took the survey geometry with it
 * (#576 D38 review). Ids in `order` without an owner, and owners whose layer is not
 * in `order` (nothing drawing at the loss), are skipped.
 */
export function reattachInOrder(
  order: readonly string[],
  owners: ReadonlyMap<string, ReattachableLayer>,
  onMap: (id: string) => boolean,
): void {
  for (let i = order.length - 1; i >= 0; i--) {
    const owner = owners.get(order[i]!);
    if (!owner) continue;
    let beforeId: string | undefined;
    for (let j = i + 1; j < order.length; j++) {
      if (onMap(order[j]!)) {
        beforeId = order[j];
        break;
      }
    }
    owner.reattach(beforeId);
  }
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
    const snapshot = order;
    order = null;
    if (snapshot) reattachInOrder(snapshot, owners, (id) => Boolean(map.getLayer(id)));
    // Without a snapshot, fall back to each layer's insertion order on top.
    else for (const owner of owners.values()) owner.reattach(undefined);
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
