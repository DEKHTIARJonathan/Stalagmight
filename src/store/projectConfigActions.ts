import type { StoreApi } from 'zustand';
import i18n from '../i18n';
import { invokeIpc } from '../utils/ipc';
import { useUIStore } from './uiStore';
import type { Config } from '../types/config';
import type { GasConfig } from '../types/ipc.generated';
import type { CommandResult } from '../types/commands';
import type { ConfigSaveReport } from '../types/ipc/ConfigSaveReport';
import { emptyCommandResult, type ProjectStore } from './projectStore';
import { TOAST_KEYS } from '../utils/toastKeys';

/**
 * Split out of `projectStore.ts` rather than rebaselined (#157: split at an API
 * boundary instead of raising the ratchet). This is a clean one: these four
 * actions form the whole config read/write surface and nothing else in the
 * store needs their internals, so they're a plain `(set, get)` factory spread
 * into `create<ProjectStore>`, matching how `create()` itself hands `set`/`get`
 * to the store body - the least invasive shape given no other store here
 * already slices itself this way.
 */
export interface ProjectConfigActions {
  loadConfig: () => Promise<void>;
  updateConfig: (config: Config) => Promise<CommandResult>;
  /**
   * Persist ONLY the `[gas]` block. Plan-mode gas controls must not go through
   * `updateConfig`: that posts the whole `Config` built from this store's
   * snapshot, which is refreshed only after a write completes, so it silently
   * reverted any other partial save that landed in between (#357 item 2).
   */
  updateGasConfig: (gas: GasConfig) => Promise<CommandResult>;
  /** Update config state without persisting to disk */
  setConfig: (config: Config) => void;
}

export function createProjectConfigActions(
  set: StoreApi<ProjectStore>['setState'],
  get: StoreApi<ProjectStore>['getState']
): ProjectConfigActions {
  return {
    loadConfig: async () => {
      try {
        const config = await invokeIpc<Config>('get_config', undefined, {
          purpose: 'load user configuration',
        });
        set({ config });
      } catch (e) {
        console.error('Failed to load config:', e);
      }
    },

    updateConfig: async (config: Config) => {
      try {
        const routingBefore = get().config?.gas.include_reference_legs;
        // Rust command returns Result<ConfigSaveReport, String> - an error throws; the
        // report carries the one thing a save can half-do (see below).
        const report = await invokeIpc<ConfigSaveReport | null>(
          'update_config',
          { config },
          { purpose: 'persist user settings' },
        );
        // Turning the "never use the OS keychain" switch on EVICTS the API key an
        // earlier login left in the keyring, and a locked or read-only keyring can
        // refuse that delete. The settings are saved either way (the eviction runs
        // before the write precisely so a partial failure lands in the recoverable
        // direction), so this cannot be an error - but it must not pass as unqualified
        // success either: Settings would be telling the user their key is not in the
        // OS keychain while a working bearer token sits in it. The backend reports
        // only a residue that may GENUINELY have survived, so this does not fire on
        // the headless box that has no keychain to strand anything in.
        if (report?.keychain_residue) {
          useUIStore
            .getState()
            .showToast(
              i18n.t('settings.speleodb.disableKeychain.evictionFailed', {
                reason: report.keychain_residue,
              }),
              TOAST_KEYS.SPELEODB_KEYCHAIN_RESIDUE,
              'warning',
            );
        }
        // The other half of that same move: the key is re-landed wherever the closed
        // gate allows, which under the default "this session only" preference is
        // memory - and the sweep that makes that true has to remove any copy an
        // earlier storage choice wrote to disk. When it cannot, the saved settings say
        // the key is gone when the app closes while the next launch reads the survivor
        // straight back and signs the user in. Deliberately does not name the keyring:
        // the backend cannot tell which store stranded it, and it is mutually
        // exclusive with the message above, which can.
        if (report?.persistent_residue) {
          useUIStore
            .getState()
            .showToast(
              i18n.t('settings.speleodb.disableKeychain.sweepFailed', {
                reason: report.persistent_residue,
              }),
              TOAST_KEYS.SPELEODB_TOKEN_RESIDUE,
              'warning',
            );
        }
        // Re-fetch config to get backend-normalized values (e.g., zoom_step clamped to valid range)
        await get().loadConfig();
        // The closure-adjustment sigmas feed the adjusted solve, so a settings change
        // can change the adjusted geometry. Drop the cached set; the map re-fetches
        // lazily (the backend memo is keyed on the config, so a stale config would
        // otherwise keep rendering the old weighted solve until an unrelated edit).
        set({ stationsAdjusted: null, surveyDataAdjusted: null });
        // `gas.include_reference_legs` decides whether penetration routes through
        // reference ties, and `stats.penetration_distance` is computed inside
        // `get_project_state` - not lazily like the geometry above. Nothing else
        // here re-runs it, so without this the Detail panel keeps showing the old
        // figure while the distance overlay and ruler (both keyed on the setting)
        // have already switched, until some unrelated command refreshes state.
        // Gated on an actual change: this is a full project refetch, too heavy to
        // fire on every unrelated settings tweak.
        if (get().config?.gas.include_reference_legs !== routingBefore) {
          await get().refreshProjectState();
        }
        return emptyCommandResult(true, null);
      } catch (e) {
        return emptyCommandResult(false, String(e));
      }
    },

    updateGasConfig: async (gas: GasConfig) => {
      try {
        const routingBefore = get().config?.gas.include_reference_legs;
        await invokeIpc('update_gas_config', { gas }, { purpose: 'persist gas planning settings' });
        // Re-fetch to pick up the backend-normalized values, same as updateConfig.
        await get().loadConfig();
        // Same reasoning as updateConfig's copy of this: `include_reference_legs`
        // decides whether penetration routes through reference ties, and
        // `stats.penetration_distance` is computed eagerly inside get_project_state.
        if (get().config?.gas.include_reference_legs !== routingBefore) {
          await get().refreshProjectState();
        }
        // Deliberately does NOT drop `stationsAdjusted` / `surveyDataAdjusted` the
        // way updateConfig does. That drop is there for the closure-adjustment
        // sigmas, which feed the least-squares solve; nothing in `[gas]` does, and
        // these writes are debounced-but-frequent while typing in a gas field.
        return emptyCommandResult(true, null);
      } catch (e) {
        return emptyCommandResult(false, String(e));
      }
    },

    setConfig: (config: Config) => {
      // Replacing the config (e.g. Settings ▸ Advanced "Reload from disk") can change
      // the closure-adjustment sigmas, so drop the cached adjusted geometry here too -
      // this is the shared config-replacement path that `updateConfig` doesn't use.
      set({ config, stationsAdjusted: null, surveyDataAdjusted: null });
    },
  };
}
