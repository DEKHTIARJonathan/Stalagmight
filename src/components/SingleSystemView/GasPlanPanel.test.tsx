/**
 * Component test (#241) - swim-speed disk-persist debounce.
 *
 * `PositiveNumberField` fires `onCommit` on every valid keystroke (not just
 * blur), and the swim-speed field's `onCommit` used to call
 * `useProjectStore.getState().updateConfig(...)` unsequenced on every one of
 * those commits - a fast typist fired one disk write per keystroke, and
 * out-of-order completion could persist an earlier intermediate value. The
 * fix debounces the disk write (keeping the in-memory `setGasConfig` update
 * immediate) so only the LATEST value is ever persisted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('./DivePlanBar', () => ({ DivePlanBar: () => null }));

import { GasPlanPanel } from './GasPlanPanel';
import { useGasPlanStore } from '../../store/gasPlanStore';
import { useProjectStore } from '../../store/projectStore';
import { defaultConfig } from '../../types/config';
import type { Config } from '../../types/config';

beforeEach(() => {
  vi.useFakeTimers();
  useGasPlanStore.setState({
    origin: null,
    endpoint: null,
    diver: { rmv_l_per_min: 20, label: null },
    cylinders: [],
    gasConfig: structuredClone(defaultConfig.gas),
    reachField: null,
    stageDropOverrides: [],
    loadedPlanId: null,
    loadedPlanBaseline: null,
    pushyAck: false,
    hydrated: true, // skip the one-time re-seed effect so gasConfig sticks
  });
  useProjectStore.setState({
    config: structuredClone(defaultConfig) as Config,
    updateConfig: vi.fn(async () => ({ success: true, error: null, warnings: [], section_ids: [] })),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GasPlanPanel swim-speed persist debounce (#241)', () => {
  it('coalesces rapid keystrokes into a single debounced updateConfig call', () => {
    render(<GasPlanPanel />);
    const input = screen.getByTestId('gas-swim-speed-input');

    fireEvent.change(input, { target: { value: '11' } });
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.change(input, { target: { value: '13' } });

    // No disk write yet - only the debounce timer has been (re)armed.
    expect(useProjectStore.getState().updateConfig).not.toHaveBeenCalled();

    vi.runAllTimers();

    const updateConfig = useProjectStore.getState().updateConfig;
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ gas: expect.objectContaining({ swim_speed_m_per_min: 13 }) }),
    );
  });

  it('updates the in-memory working config immediately on every keystroke', () => {
    render(<GasPlanPanel />);
    const input = screen.getByTestId('gas-swim-speed-input');

    fireEvent.change(input, { target: { value: '14' } });

    expect(useGasPlanStore.getState().gasConfig.swim_speed_m_per_min).toBe(14);
    // Still debounced - the disk write hasn't fired.
    expect(useProjectStore.getState().updateConfig).not.toHaveBeenCalled();
  });

  it('flushes a pending write on unmount so a value typed right before leaving is not lost', () => {
    const { unmount } = render(<GasPlanPanel />);
    const input = screen.getByTestId('gas-swim-speed-input');

    fireEvent.change(input, { target: { value: '15' } });
    expect(useProjectStore.getState().updateConfig).not.toHaveBeenCalled();

    // Leaving Plan mode unmounts the panel before the 450ms debounce elapses; the
    // pending value must still be persisted (parity with the pre-debounce behavior
    // that wrote every keystroke), not dropped.
    unmount();

    const updateConfig = useProjectStore.getState().updateConfig;
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ gas: expect.objectContaining({ swim_speed_m_per_min: 15 }) }),
    );
  });
});
