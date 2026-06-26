import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '../uiStore';
import { useGasPlanStore } from '../gasPlanStore';

/**
 * The Plan workspace mode (#38) paints the same shots/stations layer as the three
 * color overlays (depth / distance / issue-severity), so they must be mutually
 * exclusive. Entering Plan clears the color overlays; enabling a color overlay —
 * reachable via the Shift+D keyboard shortcut, which calls toggleDisplay directly,
 * bypassing setColorMode — returns to Survey (exitGasPlan). These guards pin BOTH
 * directions.
 */
describe('Plan mode ↔ color-overlay mutual exclusion (#38)', () => {
  beforeEach(() => {
    useUIStore.setState({
      appMode: 'survey',
      geometryMode: 'measured',
      showDepthGradient: false,
      showDistanceGradient: false,
      showIssueSeverity: false,
      distanceGradientOrigin: null,
      distanceField: null,
    });
    useGasPlanStore.getState().reset();
  });

  it('entering Plan clears all three color overlays and forces the read-only closure map', () => {
    useUIStore.setState({ showDepthGradient: true });
    useUIStore.getState().setAppMode('plan');
    const s = useUIStore.getState();
    expect(s.appMode).toBe('plan');
    expect(s.geometryMode).toBe('closureAdjusted');
    expect(s.showDepthGradient).toBe(false);
    expect(s.showDistanceGradient).toBe(false);
    expect(s.showIssueSeverity).toBe(false);
  });

  it.each([
    ['depth via toggleDisplay (the Shift+D path)', () => useUIStore.getState().toggleDisplay('showDepthGradient')],
    ['distance via toggleDistanceGradient', () => useUIStore.getState().toggleDistanceGradient()],
    ['issue-severity via toggleIssueSeverity', () => useUIStore.getState().toggleIssueSeverity()],
    ['issue-severity via setIssueSeverity(true)', () => useUIStore.getState().setIssueSeverity(true)],
    ['distance via setColorMode (the DisplayMenu path)', () => useUIStore.getState().setColorMode('distance')],
    ['depth via setColorMode', () => useUIStore.getState().setColorMode('depth')],
  ])('enabling a color overlay (%s) returns to Survey', (_name, enable) => {
    useUIStore.getState().setAppMode('plan');
    expect(useUIStore.getState().appMode).toBe('plan');
    enable();
    expect(useUIStore.getState().appMode).toBe('survey');
  });

  it('setColorMode("section") while in Plan returns to Survey (no overlay selected)', () => {
    // 'section' = no color overlay; Plan still owns the layer paint, so picking it must
    // leave Plan. Guards the setColorMode early-return path (colorModeOf is already
    // 'section' in Plan, so the exit must run BEFORE the no-op check).
    useUIStore.getState().setAppMode('plan');
    expect(useUIStore.getState().appMode).toBe('plan');
    useUIStore.getState().setColorMode('section');
    expect(useUIStore.getState().appMode).toBe('survey');
  });

  it('returning to Survey restores the prior geometry mode and resets the gasPlanStore', () => {
    // Enter Plan from a closure-adjusted survey view: the forced closureAdjusted is the
    // same value, but on exit the saved survey value must come back (here: closureAdjusted).
    useUIStore.setState({ geometryMode: 'closureAdjusted' });
    useUIStore.getState().setAppMode('plan');
    useGasPlanStore.getState().setOrigin({ section_id: 2, station_index: 1 });
    expect(useGasPlanStore.getState().origin).not.toBeNull();
    useUIStore.getState().setAppMode('survey');
    expect(useUIStore.getState().appMode).toBe('survey');
    expect(useUIStore.getState().geometryMode).toBe('closureAdjusted');
    expect(useGasPlanStore.getState().origin).toBeNull();
  });

  it('exitGasPlan returns to Survey from Plan and from Export', () => {
    useUIStore.getState().setAppMode('plan');
    useUIStore.getState().exitGasPlan();
    expect(useUIStore.getState().appMode).toBe('survey');

    useUIStore.getState().setAppMode('export');
    expect(useUIStore.getState().appMode).toBe('export');
    useUIStore.getState().exitGasPlan();
    expect(useUIStore.getState().appMode).toBe('survey');
  });
});
