import { describe, it, expect } from 'vitest';
import { TANK_PRESETS, cylinderFromPreset } from '../tankPresets';

describe('tankPresets', () => {
  it('cylinderFromPreset defaults fill to rated and carries the preset fields', () => {
    const al80 = TANK_PRESETS.find((p) => p.id === 'al80')!;
    const c = cylinderFromPreset(al80);
    expect(c.water_volume_l).toBe(11.1);
    expect(c.rated_pressure_bar).toBe(207);
    expect(c.fill_bar).toBe(207); // defaults to rated; the user overfills in-panel
    expect(c.material).toBe('aluminium');
    expect(c.role).toBe('back_gas');
    expect(c.label).toBe('AL80');
  });

  it('AL40 is a deco-only preset (excluded from the OC penetration budget)', () => {
    const al40 = TANK_PRESETS.find((p) => p.id === 'al40')!;
    expect(al40.role).toBe('deco');
  });

  it('has unique preset ids', () => {
    const ids = TANK_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every preset has positive water volume and rated pressure', () => {
    for (const p of TANK_PRESETS) {
      expect(p.water_volume_l).toBeGreaterThan(0);
      expect(p.rated_pressure_bar).toBeGreaterThan(0);
    }
  });
});
