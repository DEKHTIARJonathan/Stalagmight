/**
 * Component test (#241 P3) - GasSettings must use the shared PositiveNumberField
 * (its own docstring already claims coverage: "the Gas settings panel share[s] one
 * deletable-number control"), not a raw `<input type="number">` + `parseFloat`. The
 * raw form re-introduces the non-deletable/parseFloat trap PositiveNumberField was
 * built to fix: `parseFloat` accepts ANY finite string (including negative/zero),
 * so a bad value commits straight through onChange with no gate; PositiveNumberField
 * only calls onCommit for a strictly-positive finite number.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { GasSettings } from './GasSettings';
import { defaultConfig } from '../../../types/config';
import type { Config } from '../../../types/config';

let onChange: ReturnType<typeof vi.fn>;

function renderPanel(overrides: Partial<Config['gas']> = {}) {
  const config: Config = {
    ...defaultConfig,
    gas: { ...defaultConfig.gas, ...overrides },
  };
  render(
    <GasSettings
      config={config}
      onChange={onChange}
      changedFields={new Set()}
      onValidationError={vi.fn()}
      panelIdBase="settings"
    />
  );
  return config;
}

beforeEach(() => {
  onChange = vi.fn();
});

describe('GasSettings numeric fields use PositiveNumberField (#241)', () => {
  it('commits a valid positive swim speed', () => {
    renderPanel({ swim_speed_m_per_min: 10 });
    fireEvent.change(screen.getByTestId('input-gas-swim-speed'), { target: { value: '12' } });
    expect(onChange).toHaveBeenCalledWith({
      gas: expect.objectContaining({ swim_speed_m_per_min: 12 }),
    });
  });

  it('never commits a non-positive swim speed (raw parseFloat would have)', () => {
    renderPanel({ swim_speed_m_per_min: 10 });
    const input = screen.getByTestId('input-gas-swim-speed');
    fireEvent.change(input, { target: { value: '-5' } });
    fireEvent.change(input, { target: { value: '0' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits a valid positive jump multiplier', () => {
    renderPanel({ jump_rmv_multiplier: 1 });
    fireEvent.change(screen.getByTestId('input-gas-jump-multiplier'), { target: { value: '1.5' } });
    expect(onChange).toHaveBeenCalledWith({
      gas: expect.objectContaining({ jump_rmv_multiplier: 1.5 }),
    });
  });

  it('never commits a non-positive jump multiplier (raw parseFloat would have)', () => {
    renderPanel({ jump_rmv_multiplier: 1 });
    const input = screen.getByTestId('input-gas-jump-multiplier');
    fireEvent.change(input, { target: { value: '-1' } });
    fireEvent.change(input, { target: { value: '0' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the field deletable: an intermediate blank draft does not force-commit', () => {
    renderPanel({ swim_speed_m_per_min: 10 });
    const input = screen.getByTestId('input-gas-swim-speed') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('GasSettings DPV rig (#317)', () => {
  it('enabling the rig seeds a rig object (null -> DpvRig)', () => {
    renderPanel({ dpv: null });
    fireEvent.click(screen.getByTestId('toggle-gas-dpv-enabled'));
    expect(onChange).toHaveBeenCalledWith({
      gas: expect.objectContaining({ dpv: expect.objectContaining({ primary: expect.any(Object) }) }),
    });
  });

  it('disabling the rig clears it back to null (DpvRig -> null)', () => {
    const rig = {
      primary: { speed_m_per_min: 24, burn_minutes: 60 },
      backup: { speed_m_per_min: 18, burn_minutes: 45 },
      range_reserve_fraction: 0.2,
    };
    renderPanel({ dpv: rig });
    fireEvent.click(screen.getByTestId('toggle-gas-dpv-enabled'));
    expect(onChange).toHaveBeenCalledWith({ gas: expect.objectContaining({ dpv: null }) });
  });

  it('a rig with an invalid primary unit blocks Save', () => {
    const onValidationError = vi.fn();
    const config: Config = {
      ...defaultConfig,
      gas: {
        ...defaultConfig.gas,
        dpv: {
          primary: { speed_m_per_min: 0, burn_minutes: 60 },
          backup: { speed_m_per_min: 18, burn_minutes: 45 },
          range_reserve_fraction: 0.2,
        },
      },
    };
    render(
      <GasSettings
        config={config}
        onChange={onChange}
        changedFields={new Set()}
        onValidationError={onValidationError}
        panelIdBase="settings"
      />
    );
    expect(onValidationError).toHaveBeenCalledWith('gas', true);
  });

  it('a valid rig does not block Save', () => {
    const onValidationError = vi.fn();
    const config: Config = {
      ...defaultConfig,
      gas: {
        ...defaultConfig.gas,
        dpv: {
          primary: { speed_m_per_min: 24, burn_minutes: 60 },
          backup: { speed_m_per_min: 18, burn_minutes: 45 },
          range_reserve_fraction: 0.2,
        },
      },
    };
    render(
      <GasSettings
        config={config}
        onChange={onChange}
        changedFields={new Set()}
        onValidationError={onValidationError}
        panelIdBase="settings"
      />
    );
    // The validation effect is edge-triggered (fires only on a hasError TRANSITION, matching
    // the swim/jump checks above) - a valid rig on the initial render matches the ref's initial
    // `false` and never fires at all.
    expect(onValidationError).not.toHaveBeenCalled();
  });

  it('the computed usable-range line matches the Rust formula for a hand-picked pair', () => {
    // Primary: 10 m/min x 100 min = 1000 m range but a slow burn. Backup: 40 m/min x 20 min =
    // 800 m range on a much shorter burn - picking the "weaker" unit by burn time (20 < 100)
    // would (wrongly) still land on the backup, so this pair does not distinguish the two
    // methods on its own; what matters is the number itself only comes out right - 800 m, not
    // 1000 m - when the engine compares RANGE (speed x burn), never burn alone.
    renderPanel({
      dpv: {
        primary: { speed_m_per_min: 10, burn_minutes: 100 },
        backup: { speed_m_per_min: 40, burn_minutes: 20 },
        range_reserve_fraction: 0.25,
      },
    });
    // weaker = min(1000, 800) = 800; usable = 800 * (1 - 0.25) = 600
    expect(screen.getByTestId('gas-dpv-usable-range-value').textContent).toBe('600 m');
  });
});

/**
 * #317 (M5): the usable-range preview and the Save-blocking validation must accept the exact
 * same domain the backend does for `range_reserve_fraction` - `[0, MAX_DPV_RANGE_RESERVE_
 * FRACTION]` (0.9, `src-tauri/src/config/gas.rs`). Before this, the preview computed with the
 * raw value while Save only blocked a NEGATIVE one - a diver typing 0.95 previewed 5% of range
 * while the backend would clamp to 0.9 and give 10%, a silent drift once saved.
 */
describe('GasSettings DPV range-reserve domain [0, 0.9] (#317)', () => {
  it('does not block Save when the range reserve sits exactly at the cap (0.9)', () => {
    const onValidationError = vi.fn();
    const config: Config = {
      ...defaultConfig,
      gas: {
        ...defaultConfig.gas,
        dpv: {
          primary: { speed_m_per_min: 24, burn_minutes: 60 },
          backup: { speed_m_per_min: 18, burn_minutes: 45 },
          range_reserve_fraction: 0.9,
        },
      },
    };
    render(
      <GasSettings
        config={config}
        onChange={onChange}
        changedFields={new Set()}
        onValidationError={onValidationError}
        panelIdBase="settings"
      />
    );
    expect(onValidationError).not.toHaveBeenCalled();
  });

  it('blocks Save when the range reserve exceeds the cap', () => {
    const onValidationError = vi.fn();
    const config: Config = {
      ...defaultConfig,
      gas: {
        ...defaultConfig.gas,
        dpv: {
          primary: { speed_m_per_min: 24, burn_minutes: 60 },
          backup: { speed_m_per_min: 18, burn_minutes: 45 },
          range_reserve_fraction: 0.9001,
        },
      },
    };
    render(
      <GasSettings
        config={config}
        onChange={onChange}
        changedFields={new Set()}
        onValidationError={onValidationError}
        panelIdBase="settings"
      />
    );
    expect(onValidationError).toHaveBeenCalledWith('gas', true);
  });

  it('the usable-range preview clamps a reserve above the cap down to 0.9', () => {
    // ⚠ CROSS-LANGUAGE PIN - twin of `test_gas_config_normalize_clamps_dpv_range_reserve_at_the_
    // cap_boundary` in `src-tauri/src/config/tests.rs`; that test names this one back. Primary and
    // backup are given EQUAL range (1000 m each) so the "weaker unit" pick can't mask the clamp:
    // an unclamped 0.95 would preview 1000 * 0.05 = 50 m; the clamped 0.9 previews 100 m.
    renderPanel({
      dpv: {
        primary: { speed_m_per_min: 10, burn_minutes: 100 },
        backup: { speed_m_per_min: 100, burn_minutes: 10 },
        range_reserve_fraction: 0.95,
      },
    });
    expect(screen.getByTestId('gas-dpv-usable-range-value').textContent).toBe('100 m');
  });
});
