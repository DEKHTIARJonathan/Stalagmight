import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '../uiStore';
import { useGasPlanStore } from '../gasPlanStore';

/**
 * The gas sub-mode (#38) paints the same shots/stations layer as the three color
 * overlays (depth / distance / issue-severity), so all four must be mutually
 * exclusive. The original slice only enforced it one way (gas entry cleared the
 * color overlays); enabling a color overlay — reachable via the Shift+D keyboard
 * shortcut, which calls toggleDisplay directly, bypassing setColorMode — left gas
 * stranded. These guards pin BOTH directions.
 */
describe('gas sub-mode ↔ color-overlay mutual exclusion (#38)', () => {
  beforeEach(() => {
    useUIStore.setState({
      showGasPlan: false,
      showDepthGradient: false,
      showDistanceGradient: false,
      showIssueSeverity: false,
      distanceGradientOrigin: null,
      distanceField: null,
    });
    useGasPlanStore.getState().reset();
  });

  it('entering gas mode clears all three color overlays', () => {
    useUIStore.setState({ showDepthGradient: true });
    useUIStore.getState().toggleGasPlan();
    const s = useUIStore.getState();
    expect(s.showGasPlan).toBe(true);
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
  ])('enabling a color overlay (%s) leaves the gas sub-mode', (_name, enable) => {
    useUIStore.getState().toggleGasPlan();
    expect(useUIStore.getState().showGasPlan).toBe(true);
    enable();
    expect(useUIStore.getState().showGasPlan).toBe(false);
  });

  it('setColorMode("section") while gas is active exits gas (no overlay selected)', () => {
    // 'section' = no color overlay; gas still owns the layer paint, so picking it must
    // leave gas mode. Guards the setColorMode early-return path (colorModeOf is already
    // 'section' in gas mode, so the gas-exit must run BEFORE the no-op check).
    useUIStore.getState().toggleGasPlan();
    expect(useUIStore.getState().showGasPlan).toBe(true);
    useUIStore.getState().setColorMode('section');
    expect(useUIStore.getState().showGasPlan).toBe(false);
  });

  it('exitGasPlan resets the gasPlanStore (origin back to entrance)', () => {
    useUIStore.getState().toggleGasPlan();
    useGasPlanStore.getState().setOrigin({ section_id: 2, station_index: 1 });
    expect(useGasPlanStore.getState().origin).not.toBeNull();
    useUIStore.getState().exitGasPlan();
    expect(useUIStore.getState().showGasPlan).toBe(false);
    expect(useGasPlanStore.getState().origin).toBeNull();
  });
});
