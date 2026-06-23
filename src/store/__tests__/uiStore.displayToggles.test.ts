/**
 * Unit tests for display toggle state logic in uiStore.
 * Tests toggle defaults, toggle action, toast throttling, and selection clearing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

// Mock Tauri invoke to prevent noisy console warnings and verify persistence calls
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

import { useUIStore, type DisplayToggleKey } from '../uiStore';
import {
  DISPLAY_DEFAULTS,
  getEffectiveShowReferenceShots,
  getEffectiveShowShotData,
} from '../displaySelectors';

// Helper function to get a clean test state for non-default tests
// This is used to reset between tests that modify state, NOT for testing defaults
const getCleanTestState = () => ({
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
  // The mutually-exclusive coloring overlays must be reset too, or a test that
  // enables one leaks it into later tests (setState merges partials) (#57 #12).
  showDistanceGradient: false,
  distanceGradientOrigin: null,
  distanceField: null,
  showIssueSeverity: false,
  gridSpacing: 10,
  toast: null,
  lastToastByKey: {},
  selection: null,
  multiSelection: [],
});

describe('Display Toggle State', () => {
  describe('Store Uses DISPLAY_DEFAULTS', () => {
    // These tests verify that the store derives its values from DISPLAY_DEFAULTS.
    // Since uiStore imports and uses DISPLAY_DEFAULTS for initial state, we verify
    // the store values match DISPLAY_DEFAULTS at any point after reset.
    // This catches drift if someone changes one but not the other.

    beforeEach(() => {
      // Reset to verify the store's resetDisplaySettings uses DISPLAY_DEFAULTS
      useUIStore.getState().resetDisplaySettings();
    });

    it('store showStations uses DISPLAY_DEFAULTS value', () => {
      expect(useUIStore.getState().showStations).toBe(DISPLAY_DEFAULTS.showStations);
    });

    it('store showShots uses DISPLAY_DEFAULTS value', () => {
      expect(useUIStore.getState().showShots).toBe(DISPLAY_DEFAULTS.showShots);
    });

    it('store showSectionNames uses DISPLAY_DEFAULTS value', () => {
      expect(useUIStore.getState().showSectionNames).toBe(DISPLAY_DEFAULTS.showSectionNames);
    });

    it('store showStationLabels uses DISPLAY_DEFAULTS value', () => {
      expect(useUIStore.getState().showStationLabels).toBe(DISPLAY_DEFAULTS.showStationLabels);
    });

    it('store showShotData uses DISPLAY_DEFAULTS value', () => {
      expect(useUIStore.getState().showShotData).toBe(DISPLAY_DEFAULTS.showShotData);
    });

    it('store showReferenceShots uses DISPLAY_DEFAULTS value', () => {
      expect(useUIStore.getState().showReferenceShots).toBe(DISPLAY_DEFAULTS.showReferenceShots);
    });

    it('store showZeroDatum uses DISPLAY_DEFAULTS value', () => {
      expect(useUIStore.getState().showZeroDatum).toBe(DISPLAY_DEFAULTS.showZeroDatum);
    });

    it('store showGrid uses DISPLAY_DEFAULTS value', () => {
      expect(useUIStore.getState().showGrid).toBe(DISPLAY_DEFAULTS.showGrid);
    });

    it('store showSatellite uses DISPLAY_DEFAULTS value', () => {
      expect(useUIStore.getState().showSatellite).toBe(DISPLAY_DEFAULTS.showSatellite);
    });

    it('store showDepthGradient uses DISPLAY_DEFAULTS value', () => {
      expect(useUIStore.getState().showDepthGradient).toBe(DISPLAY_DEFAULTS.showDepthGradient);
    });

    it('store gridSpacing uses DISPLAY_DEFAULTS value', () => {
      expect(useUIStore.getState().gridSpacing).toBe(DISPLAY_DEFAULTS.gridSpacing);
    });

    it('DISPLAY_DEFAULTS contains all expected toggle keys', () => {
      // Verify DISPLAY_DEFAULTS has all the keys we expect
      // This catches if someone adds a new toggle to the store but forgets DISPLAY_DEFAULTS
      const expectedKeys = [
        'showStations',
        'showShots',
        'showSectionNames',
        'showStationLabels',
        'showShotData',
        'showReferenceShots',
        'showZeroDatum',
        'showGrid',
        'showSatellite',
        'showDepthGradient',
        'gridSpacing',
      ];
      for (const key of expectedKeys) {
        expect(DISPLAY_DEFAULTS).toHaveProperty(key);
      }
    });
  });

  describe('resetDisplaySettings Action', () => {
    it('resets all display settings to DISPLAY_DEFAULTS', () => {
      // Modify ALL settings to non-default values
      useUIStore.setState({
        showStations: !DISPLAY_DEFAULTS.showStations,
        showShots: !DISPLAY_DEFAULTS.showShots,
        showSectionNames: !DISPLAY_DEFAULTS.showSectionNames,
        showStationLabels: !DISPLAY_DEFAULTS.showStationLabels,
        showShotData: !DISPLAY_DEFAULTS.showShotData,
        showReferenceShots: !DISPLAY_DEFAULTS.showReferenceShots,
        showZeroDatum: !DISPLAY_DEFAULTS.showZeroDatum,
        showGrid: !DISPLAY_DEFAULTS.showGrid,
        showSatellite: !DISPLAY_DEFAULTS.showSatellite,
        showDepthGradient: !DISPLAY_DEFAULTS.showDepthGradient,
        gridSpacing: 99,
      });

      // Reset
      useUIStore.getState().resetDisplaySettings();

      // Verify ALL defaults are restored matching DISPLAY_DEFAULTS
      const state = useUIStore.getState();
      expect(state.showStations).toBe(DISPLAY_DEFAULTS.showStations);
      expect(state.showShots).toBe(DISPLAY_DEFAULTS.showShots);
      expect(state.showSectionNames).toBe(DISPLAY_DEFAULTS.showSectionNames);
      expect(state.showStationLabels).toBe(DISPLAY_DEFAULTS.showStationLabels);
      expect(state.showShotData).toBe(DISPLAY_DEFAULTS.showShotData);
      expect(state.showReferenceShots).toBe(DISPLAY_DEFAULTS.showReferenceShots);
      expect(state.showZeroDatum).toBe(DISPLAY_DEFAULTS.showZeroDatum);
      expect(state.showGrid).toBe(DISPLAY_DEFAULTS.showGrid);
      expect(state.showSatellite).toBe(DISPLAY_DEFAULTS.showSatellite);
      expect(state.showDepthGradient).toBe(DISPLAY_DEFAULTS.showDepthGradient);
      expect(state.gridSpacing).toBe(DISPLAY_DEFAULTS.gridSpacing);
    });
  });

  describe('toggleDisplay Action', () => {
    beforeEach(() => {
      useUIStore.setState(getCleanTestState());
      vi.clearAllMocks();
    });

    it('toggles showStations from true to false', () => {
      const { toggleDisplay } = useUIStore.getState();
      expect(useUIStore.getState().showStations).toBe(true);
      toggleDisplay('showStations');
      expect(useUIStore.getState().showStations).toBe(false);
    });

    it('toggles showStations from false to true', () => {
      useUIStore.setState({ showStations: false });
      const { toggleDisplay } = useUIStore.getState();
      expect(useUIStore.getState().showStations).toBe(false);
      toggleDisplay('showStations');
      expect(useUIStore.getState().showStations).toBe(true);
    });

    it('toggles showShots correctly', () => {
      const { toggleDisplay } = useUIStore.getState();
      expect(useUIStore.getState().showShots).toBe(true);
      toggleDisplay('showShots');
      expect(useUIStore.getState().showShots).toBe(false);
      toggleDisplay('showShots');
      expect(useUIStore.getState().showShots).toBe(true);
    });

    it('toggles all display keys independently', () => {
      const toggleKeys: DisplayToggleKey[] = [
        'showStations',
        'showShots',
        'showSectionNames',
        'showStationLabels',
        'showShotData',
        'showReferenceShots',
        'showZeroDatum',
        'showGrid',
        'showSatellite',
        'showDepthGradient',
      ];

      for (const key of toggleKeys) {
        const initialValue = useUIStore.getState()[key];
        useUIStore.getState().toggleDisplay(key);
        expect(useUIStore.getState()[key]).toBe(!initialValue);
      }
    });

    it('persists toggle state via invoke', async () => {
      const { toggleDisplay } = useUIStore.getState();

      toggleDisplay('showStations');

      // Wait for async persistence
      await vi.waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('save_display_setting', {
          key: 'showStations',
          value: 'false',
        });
      });
    });

    it('persists each toggle with correct value', async () => {
      const { toggleDisplay } = useUIStore.getState();

      // Toggle showGrid (default false -> true)
      toggleDisplay('showGrid');

      await vi.waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('save_display_setting', {
          key: 'showGrid',
          value: 'true',
        });
      });
    });
  });

  // Depth and distance gradients both paint the shots layer; showing both at once
  // produced mixed coloring (depth-colored shots, distance-colored stations after
  // a Shots toggle). They are mutually exclusive — enabling one disables the other
  // — so the conflicting state is unreachable (#34, Daniel's report).
  describe('Distance/Depth Gradient Mutual Exclusion (#34)', () => {
    beforeEach(() => {
      useUIStore.setState(getCleanTestState());
      vi.clearAllMocks();
    });

    it('enabling the distance gradient turns the depth gradient off', () => {
      useUIStore.setState({ showDepthGradient: true, showDistanceGradient: false });
      useUIStore.getState().toggleDistanceGradient();
      const s = useUIStore.getState();
      expect(s.showDistanceGradient).toBe(true);
      expect(s.showDepthGradient).toBe(false);
    });

    it('enabling the depth gradient turns the distance gradient off and clears its origin/field', () => {
      useUIStore.setState({
        showDistanceGradient: true,
        distanceGradientOrigin: { section_id: 1, station_index: 2 },
        distanceField: {} as never,
        showDepthGradient: false,
      });
      useUIStore.getState().toggleDisplay('showDepthGradient');
      const s = useUIStore.getState();
      expect(s.showDepthGradient).toBe(true);
      expect(s.showDistanceGradient).toBe(false);
      expect(s.distanceGradientOrigin).toBeNull();
      expect(s.distanceField).toBeNull();
    });

    it('never leaves both gradients enabled, from either entry point', () => {
      useUIStore.setState({ showDepthGradient: true, showDistanceGradient: false });
      useUIStore.getState().toggleDistanceGradient();
      let s = useUIStore.getState();
      expect(s.showDepthGradient && s.showDistanceGradient).toBe(false);
      useUIStore.getState().toggleDisplay('showDepthGradient');
      s = useUIStore.getState();
      expect(s.showDepthGradient && s.showDistanceGradient).toBe(false);
    });

    it('does not persist depth=off when it is suppressed by enabling the distance overlay', () => {
      useUIStore.setState({ showDepthGradient: true, showDistanceGradient: false });
      useUIStore.getState().toggleDistanceGradient();
      // Distance is runtime-only; the depth gradient's persisted preference must
      // be left untouched so it returns next session.
      expect(invoke).not.toHaveBeenCalledWith(
        'save_display_setting',
        expect.objectContaining({ key: 'showDepthGradient' })
      );
    });
  });

  // Issue-severity coloring also paints the shots/stations layer, so it is
  // mutually exclusive with both gradients and, like the distance overlay, is
  // runtime-only (never persisted) (#22).
  describe('Issue-severity Mutual Exclusion (#22)', () => {
    beforeEach(() => {
      useUIStore.setState(getCleanTestState());
      vi.clearAllMocks();
    });

    it('enabling issue severity turns off both gradients and clears the distance origin/field', () => {
      useUIStore.setState({
        showDepthGradient: true,
        showDistanceGradient: true,
        distanceGradientOrigin: { section_id: 1, station_index: 2 },
        distanceField: {} as never,
        showIssueSeverity: false,
      });
      useUIStore.getState().toggleIssueSeverity();
      const s = useUIStore.getState();
      expect(s.showIssueSeverity).toBe(true);
      expect(s.showDepthGradient).toBe(false);
      expect(s.showDistanceGradient).toBe(false);
      expect(s.distanceGradientOrigin).toBeNull();
      expect(s.distanceField).toBeNull();
    });

    it('enabling the depth gradient turns issue severity off', () => {
      useUIStore.setState({ showIssueSeverity: true, showDepthGradient: false });
      useUIStore.getState().toggleDisplay('showDepthGradient');
      const s = useUIStore.getState();
      expect(s.showDepthGradient).toBe(true);
      expect(s.showIssueSeverity).toBe(false);
    });

    it('enabling the distance gradient turns issue severity off', () => {
      useUIStore.setState({ showIssueSeverity: true, showDistanceGradient: false });
      useUIStore.getState().toggleDistanceGradient();
      const s = useUIStore.getState();
      expect(s.showDistanceGradient).toBe(true);
      expect(s.showIssueSeverity).toBe(false);
    });

    it('setIssueSeverity(true) enables it exclusively; setIssueSeverity(false) clears it', () => {
      useUIStore.setState({ showDepthGradient: true, showIssueSeverity: false });
      useUIStore.getState().setIssueSeverity(true);
      let s = useUIStore.getState();
      expect(s.showIssueSeverity).toBe(true);
      expect(s.showDepthGradient).toBe(false);
      useUIStore.getState().setIssueSeverity(false);
      s = useUIStore.getState();
      expect(s.showIssueSeverity).toBe(false);
    });

    it('is runtime-only — toggling it never persists a display setting', () => {
      useUIStore.setState({ showIssueSeverity: false });
      useUIStore.getState().toggleIssueSeverity();
      expect(invoke).not.toHaveBeenCalledWith(
        'save_display_setting',
        expect.objectContaining({ key: 'showIssueSeverity' })
      );
    });
  });
});

describe('Effective Value Selectors', () => {
  // These tests verify the effective value gating logic used for rendering.
  // Effective values determine actual visibility based on parent-child toggle relationships.

  describe('getEffectiveShowReferenceShots', () => {
    it('returns true when both showShots and showReferenceShots are true', () => {
      expect(getEffectiveShowReferenceShots(true, true)).toBe(true);
    });

    it('returns false when showShots is false (regardless of showReferenceShots)', () => {
      expect(getEffectiveShowReferenceShots(false, true)).toBe(false);
      expect(getEffectiveShowReferenceShots(false, false)).toBe(false);
    });

    it('returns false when showReferenceShots is false (regardless of showShots)', () => {
      expect(getEffectiveShowReferenceShots(true, false)).toBe(false);
    });
  });

  describe('getEffectiveShowShotData', () => {
    it('returns true when both showShots and showShotData are true', () => {
      expect(getEffectiveShowShotData(true, true)).toBe(true);
    });

    it('returns false when showShots is false (regardless of showShotData)', () => {
      expect(getEffectiveShowShotData(false, true)).toBe(false);
      expect(getEffectiveShowShotData(false, false)).toBe(false);
    });

    it('returns false when showShotData is false (regardless of showShots)', () => {
      expect(getEffectiveShowShotData(true, false)).toBe(false);
    });
  });

  describe('Effective values from store state', () => {
    // These tests verify that effective values computed from store state
    // match what the pure selector functions return.
    // This validates the integration between store state and selectors.

    beforeEach(() => {
      useUIStore.setState(getCleanTestState());
    });

    it('effective reference shots is true when store has showShots=true and showReferenceShots=true', () => {
      const state = useUIStore.getState();
      expect(getEffectiveShowReferenceShots(state.showShots, state.showReferenceShots)).toBe(true);
    });

    it('effective reference shots is false when showShots is toggled off', () => {
      useUIStore.getState().toggleDisplay('showShots');
      const state = useUIStore.getState();
      expect(getEffectiveShowReferenceShots(state.showShots, state.showReferenceShots)).toBe(false);
    });

    it('effective reference shots is false when showReferenceShots is toggled off', () => {
      useUIStore.getState().toggleDisplay('showReferenceShots');
      const state = useUIStore.getState();
      expect(getEffectiveShowReferenceShots(state.showShots, state.showReferenceShots)).toBe(false);
    });

    it('effective shot data is false by default (showShotData defaults to false)', () => {
      const state = useUIStore.getState();
      expect(getEffectiveShowShotData(state.showShots, state.showShotData)).toBe(false);
    });

    it('effective shot data is true when showShotData is toggled on', () => {
      useUIStore.getState().toggleDisplay('showShotData');
      const state = useUIStore.getState();
      expect(getEffectiveShowShotData(state.showShots, state.showShotData)).toBe(true);
    });

    it('effective shot data is false when showShots is off (even with showShotData=true)', () => {
      useUIStore.getState().toggleDisplay('showShotData'); // on
      useUIStore.getState().toggleDisplay('showShots'); // off
      const state = useUIStore.getState();
      expect(getEffectiveShowShotData(state.showShots, state.showShotData)).toBe(false);
    });
  });
});

describe('Toggle State Preservation', () => {
  // These tests verify that the store preserves toggle states independently.
  // The "effective value" gating is computed by selectors; the store just holds state.

  beforeEach(() => {
    useUIStore.setState(getCleanTestState());
  });

  it('showReferenceShots state is preserved when showShots toggles off/on', () => {
    // Initial: showShots=true, showReferenceShots=true
    expect(useUIStore.getState().showShots).toBe(true);
    expect(useUIStore.getState().showReferenceShots).toBe(true);

    // Turn off showReferenceShots
    useUIStore.getState().toggleDisplay('showReferenceShots');
    expect(useUIStore.getState().showReferenceShots).toBe(false);

    // Toggle showShots off
    useUIStore.getState().toggleDisplay('showShots');
    expect(useUIStore.getState().showShots).toBe(false);

    // showReferenceShots state should be preserved (still false)
    expect(useUIStore.getState().showReferenceShots).toBe(false);

    // Toggle showShots back on
    useUIStore.getState().toggleDisplay('showShots');
    expect(useUIStore.getState().showShots).toBe(true);

    // showReferenceShots should still be false (preserved state)
    expect(useUIStore.getState().showReferenceShots).toBe(false);
  });

  it('showShotData state is preserved when showShots toggles off/on', () => {
    // Turn on showShotData
    useUIStore.getState().toggleDisplay('showShotData');
    expect(useUIStore.getState().showShotData).toBe(true);

    // Toggle showShots off
    useUIStore.getState().toggleDisplay('showShots');

    // showShotData state should be preserved
    expect(useUIStore.getState().showShotData).toBe(true);

    // Toggle showShots back on
    useUIStore.getState().toggleDisplay('showShots');

    // showShotData should still be true (preserved state)
    expect(useUIStore.getState().showShotData).toBe(true);
  });

  it('multiple dependent toggles preserve state through parent toggle cycle', () => {
    // Set up: showShots=true, showReferenceShots=false, showShotData=true
    useUIStore.getState().toggleDisplay('showReferenceShots'); // true -> false
    useUIStore.getState().toggleDisplay('showShotData'); // false -> true

    expect(useUIStore.getState().showShots).toBe(true);
    expect(useUIStore.getState().showReferenceShots).toBe(false);
    expect(useUIStore.getState().showShotData).toBe(true);

    // Toggle parent off then on
    useUIStore.getState().toggleDisplay('showShots');
    useUIStore.getState().toggleDisplay('showShots');

    // Both dependent states should be preserved
    expect(useUIStore.getState().showReferenceShots).toBe(false);
    expect(useUIStore.getState().showShotData).toBe(true);
  });
});

describe('Toast Throttling', () => {
  beforeEach(() => {
    useUIStore.setState(getCleanTestState());
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Clear any pending timers before switching back to real timers
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('first toast shows immediately', () => {
    const { showToast } = useUIStore.getState();
    showToast('Test message', 'test-key');
    expect(useUIStore.getState().toast?.message).toBe('Test message');
  });

  it('rapid toasts with same key are throttled', () => {
    const { showToast } = useUIStore.getState();
    showToast('First', 'same-key');
    expect(useUIStore.getState().toast?.message).toBe('First');

    showToast('Second', 'same-key'); // Should be ignored (within 5s cooldown)
    expect(useUIStore.getState().toast?.message).toBe('First');
  });

  it('toast shows after 5 second cooldown', () => {
    const { showToast } = useUIStore.getState();
    showToast('First', 'test-key');
    expect(useUIStore.getState().toast?.message).toBe('First');

    // Advance time past 5 second cooldown
    vi.advanceTimersByTime(5001);

    showToast('Second', 'test-key');
    expect(useUIStore.getState().toast?.message).toBe('Second');
  });

  it('toast auto-clears after 3 seconds', () => {
    const { showToast } = useUIStore.getState();
    showToast('Test', 'test-key');
    expect(useUIStore.getState().toast).not.toBeNull();

    // Advance time past 3 second auto-clear
    vi.advanceTimersByTime(3001);

    expect(useUIStore.getState().toast).toBeNull();
  });

  it('separate throttle tracking for different keys', () => {
    const { showToast } = useUIStore.getState();

    // Show toast for stations key
    showToast('Stations message', 'stations');
    expect(useUIStore.getState().toast?.message).toBe('Stations message');

    // Show toast for shots key (different key, should show)
    showToast('Shots message', 'shots');
    expect(useUIStore.getState().toast?.message).toBe('Shots message');

    // Try again for stations key (same key, should be throttled)
    showToast('Stations again', 'stations');
    expect(useUIStore.getState().toast?.message).toBe('Shots message');
  });

  it('toast tracks lastToastByKey correctly', () => {
    const { showToast } = useUIStore.getState();

    // Initial state has no toast history
    expect(useUIStore.getState().lastToastByKey).toEqual({});

    // Show first toast
    showToast('Test', 'key-a');
    expect(useUIStore.getState().lastToastByKey['key-a']).toBeDefined();
    expect(typeof useUIStore.getState().lastToastByKey['key-a']).toBe('number');

    // Show toast with different key
    showToast('Test 2', 'key-b');
    expect(useUIStore.getState().lastToastByKey['key-a']).toBeDefined();
    expect(useUIStore.getState().lastToastByKey['key-b']).toBeDefined();
  });

  it('clearToast removes current toast', () => {
    const { showToast, clearToast } = useUIStore.getState();

    showToast('Test', 'key');
    expect(useUIStore.getState().toast).not.toBeNull();

    clearToast();
    expect(useUIStore.getState().toast).toBeNull();
  });
});

describe('Selection Clearing', () => {
  beforeEach(() => {
    useUIStore.setState(getCleanTestState());
  });

  it('clearSelectionByType clears only stations when type is station', () => {
    const stationSelection = {
      type: 'station' as const,
      stationRef: { section_id: 1, station_index: 0 },
    };
    const shotSelection = {
      type: 'shot' as const,
      sectionId: 1,
      shotId: 0,
    };

    // Add both selections
    useUIStore.getState().addToSelection(stationSelection);
    useUIStore.getState().addToSelection(shotSelection);

    expect(useUIStore.getState().multiSelection).toHaveLength(2);

    // Clear only stations
    useUIStore.getState().clearSelectionByType('station');

    // Only shot should remain
    const remaining = useUIStore.getState().multiSelection;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.type).toBe('shot');
    expect(remaining[0]!.sectionId).toBe(1);
    expect(remaining[0]!.shotId).toBe(0);
  });

  it('clearSelectionByType clears only shots when type is shot', () => {
    const stationSelection = {
      type: 'station' as const,
      stationRef: { section_id: 1, station_index: 0 },
    };
    const shotSelection = {
      type: 'shot' as const,
      sectionId: 1,
      shotId: 0,
    };

    // Add both selections
    useUIStore.getState().addToSelection(stationSelection);
    useUIStore.getState().addToSelection(shotSelection);

    expect(useUIStore.getState().multiSelection).toHaveLength(2);

    // Clear only shots
    useUIStore.getState().clearSelectionByType('shot');

    // Only station should remain
    const remaining = useUIStore.getState().multiSelection;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.type).toBe('station');
    expect(remaining[0]!.stationRef?.section_id).toBe(1);
    expect(remaining[0]!.stationRef?.station_index).toBe(0);
  });

  it('clearSelectionByType updates selection to last remaining item', () => {
    const stationSelection1 = {
      type: 'station' as const,
      stationRef: { section_id: 1, station_index: 0 },
    };
    const stationSelection2 = {
      type: 'station' as const,
      stationRef: { section_id: 1, station_index: 1 },
    };
    const shotSelection = {
      type: 'shot' as const,
      sectionId: 1,
      shotId: 0,
    };

    // Add selections in order
    useUIStore.getState().addToSelection(stationSelection1);
    useUIStore.getState().addToSelection(stationSelection2);
    useUIStore.getState().addToSelection(shotSelection);

    // Current selection should be the last added (shot)
    expect(useUIStore.getState().selection?.type).toBe('shot');

    // Clear shots - selection should update to last remaining station (station2)
    useUIStore.getState().clearSelectionByType('shot');

    const selection = useUIStore.getState().selection;
    expect(selection?.type).toBe('station');
    // Verify it's specifically station2 (station_index: 1), not station1
    expect(selection?.stationRef?.station_index).toBe(1);
    expect(useUIStore.getState().multiSelection).toHaveLength(2);
  });

  it('filterSelection removes items that fail predicate', () => {
    const stationSelection = {
      type: 'station' as const,
      stationRef: { section_id: 1, station_index: 0 },
    };
    const shotSelection = {
      type: 'shot' as const,
      sectionId: 1,
      shotId: 0,
    };

    // Add both selections
    useUIStore.getState().addToSelection(stationSelection);
    useUIStore.getState().addToSelection(shotSelection);

    // Filter to keep only stations
    useUIStore.getState().filterSelection((s) => s.type === 'station');

    const remaining = useUIStore.getState().multiSelection;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.type).toBe('station');
    expect(remaining[0]!.stationRef?.section_id).toBe(1);
    expect(remaining[0]!.stationRef?.station_index).toBe(0);
  });

  it('clearSelectionByType with empty selection does nothing', () => {
    expect(useUIStore.getState().multiSelection).toHaveLength(0);
    expect(useUIStore.getState().selection).toBeNull();

    useUIStore.getState().clearSelectionByType('station');

    expect(useUIStore.getState().multiSelection).toHaveLength(0);
    expect(useUIStore.getState().selection).toBeNull();
  });
});

describe('Grid Spacing', () => {
  beforeEach(() => {
    useUIStore.setState(getCleanTestState());
    vi.clearAllMocks();
  });

  it('setGridSpacing updates gridSpacing value', () => {
    expect(useUIStore.getState().gridSpacing).toBe(10);

    useUIStore.getState().setGridSpacing(25);
    expect(useUIStore.getState().gridSpacing).toBe(25);

    useUIStore.getState().setGridSpacing(5);
    expect(useUIStore.getState().gridSpacing).toBe(5);
  });

  it('setGridSpacing persists value via invoke', async () => {
    useUIStore.getState().setGridSpacing(25);

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('save_display_setting', {
        key: 'gridSpacing',
        value: '25',
      });
    });
  });
});

describe('Geometry Mode', () => {
  beforeEach(() => {
    useUIStore.setState({ geometryMode: 'measured' });
    vi.clearAllMocks();
  });

  it('defaults to measured after reset', () => {
    useUIStore.setState({ geometryMode: 'closureAdjusted' });
    useUIStore.getState().resetDisplaySettings();
    expect(useUIStore.getState().geometryMode).toBe('measured');
  });

  it('setGeometryMode updates state', () => {
    useUIStore.getState().setGeometryMode('closureAdjusted');
    expect(useUIStore.getState().geometryMode).toBe('closureAdjusted');
  });

  it('setGeometryMode persists the mode via invoke', async () => {
    useUIStore.getState().setGeometryMode('closureAdjusted');
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('save_display_setting', {
        key: 'geometryMode',
        value: 'closureAdjusted',
      });
    });
  });

  it('setGeometryMode is a no-op when already in that mode', () => {
    useUIStore.setState({ geometryMode: 'measured' });
    vi.clearAllMocks();
    useUIStore.getState().setGeometryMode('measured');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('loadDisplaySettings restores a persisted geometryMode ("remember last used")', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ geometryMode: 'closureAdjusted' });
    await useUIStore.getState().loadDisplaySettings();
    expect(useUIStore.getState().geometryMode).toBe('closureAdjusted');
  });

  it('loadDisplaySettings ignores an invalid persisted geometryMode', async () => {
    useUIStore.setState({ geometryMode: 'measured' });
    vi.mocked(invoke).mockResolvedValueOnce({ geometryMode: 'not-a-mode' });
    await useUIStore.getState().loadDisplaySettings();
    expect(useUIStore.getState().geometryMode).toBe('measured');
  });

  it('loadDisplaySettings resets geometryMode to measured when no preference is saved (no carry-over)', async () => {
    // Leaving a prior project in closureAdjusted must not bleed into a project
    // whose saved settings omit geometryMode (e.g. an older file).
    useUIStore.setState({ geometryMode: 'closureAdjusted' });
    vi.mocked(invoke).mockResolvedValueOnce({ showStations: 'true' });
    await useUIStore.getState().loadDisplaySettings();
    expect(useUIStore.getState().geometryMode).toBe('measured');
  });

  it('applyDisplaySettings restores the saved geometryMode and never inherits the previous one', () => {
    // No saved preference (backend sends "measured") → measured, not carried over.
    useUIStore.setState({ geometryMode: 'closureAdjusted' });
    useUIStore.getState().applyDisplaySettings({ geometryMode: 'measured' } as never);
    expect(useUIStore.getState().geometryMode).toBe('measured');

    // A saved closureAdjusted preference is restored ("remember last used").
    useUIStore.setState({ geometryMode: 'measured' });
    useUIStore.getState().applyDisplaySettings({ geometryMode: 'closureAdjusted' } as never);
    expect(useUIStore.getState().geometryMode).toBe('closureAdjusted');
  });

  it('geometryMode is NOT part of DISPLAY_DEFAULTS (telemetry registry contract)', () => {
    expect('geometryMode' in DISPLAY_DEFAULTS).toBe(false);
  });

  it('applyDisplaySettings resets showDevStats so it never leaks across project loads', () => {
    // Dev stats (memory probe + map dev overlay) is session-only and absent from
    // the backend payload; a project load must reset it, not inherit it.
    useUIStore.setState({ showDevStats: true });
    useUIStore.getState().applyDisplaySettings({ geometryMode: 'measured' } as never);
    expect(useUIStore.getState().showDevStats).toBe(false);
  });

  it('setView(global) resets showDevStats so the probe cannot strand over GlobalView', () => {
    // The Display toggle lives only in SingleSystemView, so leaving for GlobalView
    // must clear it — otherwise the app-mounted probe lingers with no way to hide.
    useUIStore.setState({ view: 'single', showDevStats: true });
    useUIStore.getState().setView('global');
    expect(useUIStore.getState().showDevStats).toBe(false);
    expect(useUIStore.getState().view).toBe('global');
  });
});
