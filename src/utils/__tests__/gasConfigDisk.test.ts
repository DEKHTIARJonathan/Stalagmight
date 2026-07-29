/**
 * The shared gas-config disk-write queue (#317 review round). Two behaviors matter and each
 * has a test that fails without its mechanism: rapid patches MERGE into one write (the
 * per-keystroke IPC/LSQ-drop regression), and a write queued while another is in flight
 * merges against the first write's LANDED state, not the pre-write snapshot (the
 * two-writers-clobber-each-other bug: the debounced swim-speed write used to read a config
 * whose `gas.dpv` predated a rig toggle inside the same window, and wrote the old rig back).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { queueGasConfigWrite, flushGasConfigWrite } from '../gasConfigDisk';
import { useProjectStore } from '../../store/projectStore';
import { defaultConfig } from '../../types/config';
import type { Config } from '../../types/config';
import type { DpvRig } from '../../types/ipc.generated';

const RIG: DpvRig = {
  primary: { speed_m_per_min: 45, burn_minutes: 60 },
  backup: { speed_m_per_min: 45, burn_minutes: 45 },
  range_reserve_fraction: 0.1,
};

const OK = { success: true, error: null, warnings: [], section_ids: [] };

beforeEach(async () => {
  // Drain a previous test's queue into its own mock before installing a fresh one.
  await flushGasConfigWrite();
  useProjectStore.setState({
    config: structuredClone(defaultConfig) as Config,
    updateConfig: vi.fn(async (cfg: Config) => {
      // Simulate the real updateConfig's post-IPC `loadConfig()`: the saved config only
      // reflects the write once the round trip completes.
      useProjectStore.setState({ config: cfg });
      return OK;
    }),
  });
});

describe('queueGasConfigWrite', () => {
  it('merges rapid patches into ONE write carrying all of them, latest value per field winning', async () => {
    queueGasConfigWrite({ swim_speed_m_per_min: 11 });
    queueGasConfigWrite({ swim_speed_m_per_min: 12 });
    queueGasConfigWrite({ dpv: RIG });
    await flushGasConfigWrite();

    const updateConfig = useProjectStore.getState().updateConfig as ReturnType<typeof vi.fn>;
    expect(updateConfig).toHaveBeenCalledTimes(1);
    const written = updateConfig.mock.calls[0]?.[0] as Config;
    expect(written.gas.swim_speed_m_per_min).toBe(12);
    expect(written.gas.dpv).toEqual(RIG);
  });

  it('is a no-op with no loaded config', async () => {
    useProjectStore.setState({ config: null });
    queueGasConfigWrite({ swim_speed_m_per_min: 9 });
    await flushGasConfigWrite();
    const updateConfig = useProjectStore.getState().updateConfig as ReturnType<typeof vi.fn>;
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('a write queued while another is in flight merges against the first write LANDING, not the stale snapshot', async () => {
    let releaseFirst = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const applied: Config[] = [];
    useProjectStore.setState({
      updateConfig: vi.fn(async (cfg: Config) => {
        applied.push(cfg);
        if (applied.length === 1) await gate; // hold the first round trip open
        useProjectStore.setState({ config: cfg });
        return OK;
      }),
    });

    queueGasConfigWrite({ swim_speed_m_per_min: 42 });
    void flushGasConfigWrite(); // first write now in flight, held at the gate

    queueGasConfigWrite({ dpv: RIG });
    const all = flushGasConfigWrite(); // second write chains behind the first

    releaseFirst();
    await all;

    expect(applied).toHaveLength(2);
    // The clobber shape this guards: a second writer reading the pre-write snapshot would
    // carry swim_speed's DEFAULT here and silently revert the first write on disk.
    expect(applied[1]?.gas.swim_speed_m_per_min).toBe(42);
    expect(applied[1]?.gas.dpv).toEqual(RIG);
  });
});
