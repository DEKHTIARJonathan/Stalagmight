import { describe, it, expect } from 'vitest';
import { backgasTurnPressureBar, stageDropPressureBar } from '../GasPlanPanel';
import type { Cylinder } from '../../../types/ipc.generated';

const al80 = (): Cylinder => ({
  water_volume_l: 11.1,
  rated_pressure_bar: 207,
  fill_bar: 207,
  material: 'aluminium',
  role: 'back_gas',
  label: 'AL80',
});

describe('backgasTurnPressureBar', () => {
  it('turns at 2/3 of the start at thirds (frac 1/3)', () => {
    // avg start 207 × (1 − 1/3) = 138 bar.
    expect(backgasTurnPressureBar([al80(), al80()], 1 / 3)).toBeCloseTo(138, 5);
  });

  it('turns at 3/4 of the start with one stage (frac 1/4)', () => {
    expect(backgasTurnPressureBar([al80(), al80()], 1 / 4)).toBeCloseTo(207 * 0.75, 5);
  });

  it('turns at 5/6 of the start with two stages (frac 1/6)', () => {
    expect(backgasTurnPressureBar([al80()], 1 / 6)).toBeCloseTo(207 * (5 / 6), 5);
  });

  it('volume-weights the average start across the back-gas unit', () => {
    const big: Cylinder = { ...al80(), water_volume_l: 24, fill_bar: 300 };
    const expected = ((207 * 11.1 + 300 * 24) / (11.1 + 24)) * (2 / 3);
    expect(backgasTurnPressureBar([al80(), big], 1 / 3)).toBeCloseTo(expected, 4);
  });

  it('returns null when the rig has no back gas', () => {
    const stageOnly: Cylinder = { ...al80(), role: 'stage' };
    expect(backgasTurnPressureBar([stageOnly], 1 / 3)).toBeNull();
  });

  it('ignores stage / bailout / deco for the back-gas gauge', () => {
    const stage: Cylinder = { ...al80(), role: 'stage' };
    const deco: Cylinder = { ...al80(), role: 'deco' };
    // Only the single back_gas AL80 counts → 138 bar.
    expect(backgasTurnPressureBar([al80(), stage, deco], 1 / 3)).toBeCloseTo(138, 5);
  });
});

describe('stageDropPressureBar', () => {
  it('drops a stage at (fill + reserve)/2 — Half Minus', () => {
    // 210 bar stage, 30 reserve → drop at 120; breathe 90 in, 90 back down to 30 on the exit.
    expect(stageDropPressureBar(210, 30)).toBe(120);
  });

  it('moves with the reserve', () => {
    expect(stageDropPressureBar(200, 0)).toBe(100);
    expect(stageDropPressureBar(200, 50)).toBe(125);
  });

  it('clamps to the fill when the reserve exceeds it (never reads above start)', () => {
    expect(stageDropPressureBar(20, 100)).toBe(20);
  });

  it('treats a negative reserve as zero (defensive)', () => {
    expect(stageDropPressureBar(200, -40)).toBe(100);
  });
});
