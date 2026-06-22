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
      dataTableMode: 'pin',
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

  it('exitDataTableFullScreen restores the prior (closed) state and clears the raw selection', () => {
    // Entered from closed (beforeEach default): exit restores it to closed
    // rather than stranding the table open.
    useUIStore.getState().enterDataTableFullScreen();
    useUIStore.getState().setRawTableSelection('shots');
    useUIStore.getState().exitDataTableFullScreen();
    const s = useUIStore.getState();
    expect(s.dataTableFullScreen).toBe(false);
    expect(s.rawTableSelection).toBeNull();
    expect(s.dataTableOpen).toBe(false);
  });

  it('exitDataTableFullScreen restores a hover-mode table instead of leaving it pinned open', () => {
    useUIStore.setState({ dataTableOpen: false, dataTableMode: 'hover' });
    useUIStore.getState().enterDataTableFullScreen();
    // Fullscreen forces the table open + pinned while active.
    expect(useUIStore.getState().dataTableOpen).toBe(true);
    expect(useUIStore.getState().dataTableMode).toBe('pin');
    useUIStore.getState().exitDataTableFullScreen();
    const s = useUIStore.getState();
    expect(s.dataTableOpen).toBe(false);
    expect(s.dataTableMode).toBe('hover');
  });

  it('exitDataTableFullScreen keeps a table that was pinned-open before', () => {
    useUIStore.setState({ dataTableOpen: true, dataTableMode: 'pin' });
    useUIStore.getState().enterDataTableFullScreen();
    useUIStore.getState().exitDataTableFullScreen();
    const s = useUIStore.getState();
    expect(s.dataTableOpen).toBe(true);
    expect(s.dataTableMode).toBe('pin');
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
