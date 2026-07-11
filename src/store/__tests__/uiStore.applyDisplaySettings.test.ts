/**
 * applyDisplaySettings restores showShots/showShotComments (#275 B2).
 *
 * Both toggles were always persisted by toggleDisplay via save_display_setting,
 * but the load path never applied them: the Rust DisplaySettings struct omitted
 * them, so the previous project's (or session default) in-memory value silently
 * won over the saved one. These tests pin the restore and the no-bleed behavior.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

import { useUIStore } from '../uiStore';
import type { DisplaySettings } from '../../types/loading';

const settingsWith = (overrides: Partial<DisplaySettings>): DisplaySettings => ({
  showStations: true,
  showShots: true,
  showSectionNames: true,
  showStationLabels: false,
  showShotData: false,
  showReferenceShots: true,
  showZeroDatum: true,
  showGrid: false,
  showSatellite: false,
  showDepthGradient: false,
  showStationComments: false,
  showShotComments: false,
  gridSpacing: 10,
  geometryMode: 'measured',
  ...overrides,
});

describe('applyDisplaySettings showShots/showShotComments restore', () => {
  beforeEach(() => {
    useUIStore.setState({ showShots: true, showShotComments: false });
  });

  it('applies saved showShots=false and showShotComments=true on load', () => {
    useUIStore
      .getState()
      .applyDisplaySettings(settingsWith({ showShots: false, showShotComments: true }));
    expect(useUIStore.getState().showShots).toBe(false);
    expect(useUIStore.getState().showShotComments).toBe(true);
  });

  it('does not bleed project A values into project B (load is authoritative)', () => {
    // Project A: comments hidden, shots hidden.
    useUIStore
      .getState()
      .applyDisplaySettings(settingsWith({ showShots: false, showShotComments: false }));
    expect(useUIStore.getState().showShots).toBe(false);
    // Project B saved the opposite; its load must win over A's in-memory state.
    useUIStore
      .getState()
      .applyDisplaySettings(settingsWith({ showShots: true, showShotComments: true }));
    expect(useUIStore.getState().showShots).toBe(true);
    expect(useUIStore.getState().showShotComments).toBe(true);
  });
});
