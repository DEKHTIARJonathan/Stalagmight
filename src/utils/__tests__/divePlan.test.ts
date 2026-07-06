import { describe, it, expect } from 'vitest';
import { deepEqual, divePlanSnapshotOf, divePlanSnapshotsEqual } from '../divePlan';
import type { DivePlanInputs } from '../divePlan';
import { defaultConfig } from '../../types/config';

const baseInputs = (): DivePlanInputs => ({
  origin: { section_id: 1, station_index: 0 },
  endpoint: null,
  diver: { rmv_l_per_min: 20, label: null },
  cylinders: [],
  gasConfig: structuredClone(defaultConfig.gas),
  stageDropOverrides: [null, { section_id: 1, station_index: 3 }],
});

describe('divePlanSnapshotOf', () => {
  it('maps the camelCase store inputs to the snake_case IPC snapshot', () => {
    const inputs = baseInputs();
    const snap = divePlanSnapshotOf(inputs);
    expect(snap.origin).toEqual({ section_id: 1, station_index: 0 });
    // The nested config + overrides are carried by reference (no copy in the mapper).
    expect(snap.gas_config).toBe(inputs.gasConfig);
    expect(snap.stage_drop_overrides).toBe(inputs.stageDropOverrides);
    // Exactly the six IPC keys, snake_case.
    expect(Object.keys(snap).sort()).toEqual(
      ['cylinders', 'diver', 'endpoint', 'gas_config', 'origin', 'stage_drop_overrides'].sort()
    );
  });
});

describe('deepEqual', () => {
  it('is true for structurally equal objects regardless of key order', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: { x: [1, 2] } }, { a: { x: [1, 2] } })).toBe(true);
  });

  it('is false for differing primitives, nested values, lengths, and null-vs-value', () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: { x: 1 } }, { a: { x: 2 } })).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual({ a: null }, { a: 1 })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('treats array order as significant (a reordered drop list is a real change)', () => {
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});

describe('divePlanSnapshotsEqual', () => {
  it('equal inputs compare equal; a diverging nested gas_config differs', () => {
    const a = divePlanSnapshotOf(baseInputs());
    const b = divePlanSnapshotOf(baseInputs());
    expect(divePlanSnapshotsEqual(a, b)).toBe(true);

    const changed = baseInputs();
    changed.gasConfig = { ...changed.gasConfig, swim_speed_m_per_min: 999 };
    expect(divePlanSnapshotsEqual(a, divePlanSnapshotOf(changed))).toBe(false);
  });

  it('a differing stage-drop override slot makes them unequal', () => {
    const a = divePlanSnapshotOf(baseInputs());
    const b = divePlanSnapshotOf({ ...baseInputs(), stageDropOverrides: [null, null] });
    expect(divePlanSnapshotsEqual(a, b)).toBe(false);
  });
});
