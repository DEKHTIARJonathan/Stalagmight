/**
 * [#576 SETTINGS-ORDER] Writes of one setting land in the order they were made.
 *
 * The config and display-setting commands run on the backend's blocking pool, so
 * two IPCs in flight at once are not applied in the order they were sent. A
 * setting the frontend persists without waiting - a quick double click on a grid
 * spacing, a geometry-mode toggle, a panel divider dragged twice, a column resize
 * flushed on unmount - could have its EARLIER value land last and be what the
 * next launch reads. Each write here waits for the previous write of the same key
 * to settle (succeeded or failed) before it starts, so the last one made is the
 * last one applied. Different keys stay independent: the backend applies each
 * write to its own fields under one lock (`modify_config`), so only same-key
 * order matters.
 *
 * The gas-planning fields are not routed through here: `utils/gasConfigDisk.ts`
 * is their one writer and already serializes (and coalesces) its own writes.
 */

const tails = new Map<string, Promise<void>>();

/**
 * Run `write` after every earlier write chained under `key` has settled, and
 * return its result. A failed write does not block the ones queued after it.
 */
export function chainSettingWrite<T>(key: string, write: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const result = previous.then(write);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return result;
}

/** Keys for the writers that share a command but not a setting. */
export const SETTING_KEYS = {
  displaySetting: (key: string) => `display-setting:${key}`,
  panelSize: (field: string) => `panel-size:${field}`,
  panelLayout: 'panel-layout',
  /** Every `patch_config` / `update_config` save, Settings dialog included. */
  config: 'config',
} as const;
