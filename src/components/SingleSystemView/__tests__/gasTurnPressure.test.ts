import { describe, it, expect } from 'vitest';
import { turnPressureBar } from '../GasPlanPanel';
import type { Cylinder } from '../../../types/ipc.generated';

const al80 = (): Cylinder => ({
  water_volume_l: 11.1,
  rated_pressure_bar: 207,
  fill_bar: 207,
  material: 'aluminium',
  role: 'back_gas',
  label: 'AL80',
});

describe('turnPressureBar', () => {
  it('matched twin AL80 at thirds turns at 2/3 of the fill (gauge math)', () => {
    // usable = 2 × 207 × 11.1 = 4595.4; thirds budget = 1531.8 L; ΣWV = 22.2.
    // turn = 207 − 1531.8/22.2 = 207 − 69 = 138 bar (= 207 × 2/3).
    const turn = turnPressureBar([al80(), al80()], 1531.8);
    expect(turn).toBeCloseTo(138, 5);
  });

  it('drops the gauge by budget ÷ Σ water-volume (common-gauge equivalent)', () => {
    // One AL80, budget 222 L → drop 222/11.1 = 20 bar → 187 bar.
    const turn = turnPressureBar([al80()], 222);
    expect(turn).toBeCloseTo(187, 5);
  });

  it('returns null when no cylinder counts toward the penetration budget', () => {
    const decoOnly: Cylinder = { ...al80(), role: 'deco', label: 'AL40' };
    expect(turnPressureBar([decoOnly], 100)).toBeNull();
  });

  it('clamps to 0 rather than reporting a negative gauge', () => {
    // Budget larger than the gas in hand → never show a negative pressure.
    expect(turnPressureBar([al80()], 999_999)).toBe(0);
  });

  it('uses the ACTUAL fill for the gauge while the (derated) budget is passed in', () => {
    // An overfilled LP85 (fill 230 on a 179-rated steel). The backend computes the
    // conservative budget from min(230,179)=179: thirds = (1/3)·179·12 = 716 L. The
    // gauge, however, starts at the ACTUAL fill (230), so the diver turns at
    // 230 − 716/12 = 170.33 bar — well above 2/3 of the rated, the conservative side.
    const lp85: Cylinder = {
      water_volume_l: 12,
      rated_pressure_bar: 179,
      fill_bar: 230,
      material: 'steel',
      role: 'back_gas',
      label: 'LP85',
    };
    const turn = turnPressureBar([lp85], 716);
    expect(turn).toBeCloseTo(170.333, 2);
  });

  it('counts only back-gas + stage cylinders (excludes bailout/dil-out/deco)', () => {
    const stage: Cylinder = { ...al80(), role: 'stage', label: 'AL80-stage' };
    const bailout: Cylinder = { ...al80(), role: 'bailout', label: 'AL80-bailout' };
    // Only the two budget cylinders (AL80 back_gas + AL80 stage) count: ΣWV 22.2,
    // avg start 207; bailout is ignored. budget 1531.8 → 138 bar, same as the twin.
    const turn = turnPressureBar([al80(), stage, bailout], 1531.8);
    expect(turn).toBeCloseTo(138, 5);
  });
});
