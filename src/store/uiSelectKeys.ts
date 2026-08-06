/**
 * Explicit-key selectors over `uiStore` (#430).
 *
 * The hot map paths used to subscribe with a rest-spread selector
 * (`({ hoveredStation, ...rest }) => rest`), which allocates a fresh ~180-key
 * object and shallow-compares ~180 keys on EVERY store notification, can never
 * bail out while the camera is moving, and silently subscribes those components
 * to every future store key. Pair a module-level key tuple with
 * {@link pickUIKeys} instead: the subscription covers exactly the keys the
 * component reads, and because the component destructures the picked object the
 * compiler rejects any key that is used but missing from the tuple, so the list
 * and the destructure cannot drift apart.
 */

import type { useUIStore } from './uiStore';

/**
 * The full uiStore snapshot (state + actions). The `UIStore` interface itself is
 * module-private, so derive it from the store handle rather than widening it.
 */
export type UIStoreState = ReturnType<typeof useUIStore.getState>;

/**
 * Project a uiStore snapshot down to an explicit key list.
 *
 * Intended shape at the call site, with the tuple hoisted to module level so the
 * selector identity is stable:
 *
 * ```ts
 * const FOO_UI_KEYS = ['activeTool', 'showShots'] as const satisfies readonly (keyof UIStoreState)[];
 * const selectFooUI = (s: UIStoreState) => pickUIKeys(s, FOO_UI_KEYS);
 * // ...
 * const { activeTool, showShots } = useUIStore(useShallow(selectFooUI));
 * ```
 */
export function pickUIKeys<K extends keyof UIStoreState>(
  state: UIStoreState,
  keys: readonly K[]
): Pick<UIStoreState, K> {
  // Empty-accumulator idiom: the loop below fills exactly the keys in `keys`,
  // which is what `Pick<UIStoreState, K>` demands.
  const picked = {} as Pick<UIStoreState, K>;
  for (const key of keys) {
    picked[key] = state[key];
  }
  return picked;
}
