/**
 * Unit tests for the data-table fullscreen mode in uiStore. The mode is
 * session-only (never persisted) and owns the raw-table selection used by
 * the fullscreen raw sqlite viewer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

import { useUIStore } from '../uiStore';

describe('uiStore data-table fullscreen', () => {
  beforeEach(() => {
    useUIStore.setState({
      view: 'single',
      dataTableFullScreen: false,
      rawTableSelection: null,
      dataTableOpen: false,
      focusedSectionId: null,
    });
  });

  it('enterDataTableFullScreen forces the data table open', () => {
    useUIStore.getState().enterDataTableFullScreen();
    const s = useUIStore.getState();
    expect(s.dataTableFullScreen).toBe(true);
    expect(s.dataTableOpen).toBe(true);
  });

  it('entering with the table already open keeps it open', () => {
    useUIStore.setState({ dataTableOpen: true });
    useUIStore.getState().enterDataTableFullScreen();
    expect(useUIStore.getState().dataTableOpen).toBe(true);
  });

  it('exitDataTableFullScreen leaves the table open and clears the raw selection', () => {
    useUIStore.getState().enterDataTableFullScreen();
    useUIStore.getState().setRawTableSelection('shots');
    useUIStore.getState().exitDataTableFullScreen();
    const s = useUIStore.getState();
    expect(s.dataTableFullScreen).toBe(false);
    expect(s.rawTableSelection).toBeNull();
    expect(s.dataTableOpen).toBe(true);
  });

  it('exitDataTableFullScreen is a no-op when not fullscreen', () => {
    useUIStore.setState({ rawTableSelection: 'shots' });
    useUIStore.getState().exitDataTableFullScreen();
    // Not in the mode → nothing is touched (no surprise raw-selection reset).
    expect(useUIStore.getState().rawTableSelection).toBe('shots');
  });

  it('setRawTableSelection stores and clears the table name', () => {
    useUIStore.getState().setRawTableSelection('sections');
    expect(useUIStore.getState().rawTableSelection).toBe('sections');
    useUIStore.getState().setRawTableSelection(null);
    expect(useUIStore.getState().rawTableSelection).toBeNull();
  });

  it('setView exits fullscreen mode (cannot strand it across views)', () => {
    useUIStore.getState().enterDataTableFullScreen();
    useUIStore.getState().setRawTableSelection('shots');
    useUIStore.getState().setView('global');
    const s = useUIStore.getState();
    expect(s.dataTableFullScreen).toBe(false);
    expect(s.rawTableSelection).toBeNull();
  });
});
