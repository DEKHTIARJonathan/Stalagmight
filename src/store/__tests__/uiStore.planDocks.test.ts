import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '../uiStore';

/**
 * Entering Plan/Export force-opens the right Dock (detail panel) and, for Plan,
 * pins the bottom Dock (data table) open too, so the setup/Cylinders panels
 * surface without hunting for a closed dock. #241: exiting back to Survey must
 * restore whatever dock state the user had BEFORE entering — mirroring the
 * existing prePlanGeometryMode/prePlanDisplay snapshot/restore pattern — rather
 * than leaving a dock the user had closed stranded open.
 */
describe('Plan/Export dock snapshot/restore (#241)', () => {
  beforeEach(() => {
    useUIStore.setState({
      appMode: 'survey',
      geometryMode: 'measured',
      detailPanelOpen: false,
      detailPanelMode: 'pin',
      dataTableOpen: false,
      dataTableMode: 'pin',
    });
  });

  it('restores a closed detail panel after leaving Plan', () => {
    expect(useUIStore.getState().detailPanelOpen).toBe(false);
    useUIStore.getState().setAppMode('plan');
    // Plan force-opens it.
    expect(useUIStore.getState().detailPanelOpen).toBe(true);
    useUIStore.getState().setAppMode('survey');
    expect(useUIStore.getState().detailPanelOpen).toBe(false);
  });

  it('restores a closed data table after leaving Plan', () => {
    expect(useUIStore.getState().dataTableOpen).toBe(false);
    useUIStore.getState().setAppMode('plan');
    // Plan force-pins the data table open.
    expect(useUIStore.getState().dataTableOpen).toBe(true);
    expect(useUIStore.getState().dataTableMode).toBe('pin');
    useUIStore.getState().setAppMode('survey');
    expect(useUIStore.getState().dataTableOpen).toBe(false);
  });

  it('restores the prior detail panel mode (e.g. hover), not just openness', () => {
    useUIStore.setState({ detailPanelOpen: true, detailPanelMode: 'hover' });
    useUIStore.getState().setAppMode('plan');
    useUIStore.getState().setAppMode('survey');
    expect(useUIStore.getState().detailPanelMode).toBe('hover');
  });

  it('restores docks after leaving Export too', () => {
    expect(useUIStore.getState().detailPanelOpen).toBe(false);
    useUIStore.getState().setAppMode('export');
    expect(useUIStore.getState().detailPanelOpen).toBe(true);
    useUIStore.getState().setAppMode('survey');
    expect(useUIStore.getState().detailPanelOpen).toBe(false);
  });

  it('leaves an already-open dock open and untouched after Plan', () => {
    useUIStore.setState({ dataTableOpen: true, dataTableMode: 'pin', detailPanelOpen: true, detailPanelMode: 'pin' });
    useUIStore.getState().setAppMode('plan');
    useUIStore.getState().setAppMode('survey');
    expect(useUIStore.getState().dataTableOpen).toBe(true);
    expect(useUIStore.getState().detailPanelOpen).toBe(true);
  });

  it('a project load is authoritative: drops the stale dock snapshot without restoring it', () => {
    // Project A: closes the docks, enters Plan (captures the closed snapshot). A DIRECT
    // switch to project B (applyDisplaySettings) must clear the stale snapshot so the
    // later exitGasPlan funnel can't restore A's closed docks over B's live state.
    useUIStore.getState().setAppMode('plan');
    useUIStore.setState({ detailPanelOpen: true, dataTableOpen: true });
    useUIStore.getState().applyDisplaySettings({ geometryMode: 'measured' } as never);
    expect(useUIStore.getState().appMode).toBe('survey');
    expect(useUIStore.getState().detailPanelOpen).toBe(true);
    expect(useUIStore.getState().dataTableOpen).toBe(true);
    // The leftover funnel is now a no-op (already survey) — B's dock state stays live.
    useUIStore.getState().exitGasPlan();
    expect(useUIStore.getState().detailPanelOpen).toBe(true);
    expect(useUIStore.getState().dataTableOpen).toBe(true);
  });
});
