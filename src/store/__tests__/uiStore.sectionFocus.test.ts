/**
 * Unit tests for section-focus mode in uiStore (#50), including the reconcile
 * with #70's closure-adjusted geometry view.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

import { useUIStore } from '../uiStore';

const FOCUS_HEIGHT = 300;

describe('uiStore section focus (#50)', () => {
  beforeEach(() => {
    // Reset the slice these tests touch to a known pre-focus layout.
    useUIStore.setState({
      focusedSectionId: null,
      sectionsPanelOpen: true,
      detailPanelOpen: true,
      dataTableOpen: false,
      dataTableHeight: 200,
      geometryMode: 'measured',
      selection: null,
    });
  });

  it('enterSectionFocus collapses side panels and opens the data table', () => {
    useUIStore.getState().enterSectionFocus(7, FOCUS_HEIGHT);
    const s = useUIStore.getState();
    expect(s.focusedSectionId).toBe(7);
    expect(s.sectionsPanelOpen).toBe(false);
    expect(s.detailPanelOpen).toBe(false);
    expect(s.dataTableOpen).toBe(true);
    // table was closed -> seeds the focus height
    expect(s.dataTableHeight).toBe(FOCUS_HEIGHT);
  });

  it('entering focus leaves the read-only closure-adjusted view for measured', () => {
    useUIStore.setState({ geometryMode: 'closureAdjusted' });
    useUIStore.getState().enterSectionFocus(3, FOCUS_HEIGHT);
    expect(useUIStore.getState().geometryMode).toBe('measured');
  });

  it('entering focus when already measured leaves geometryMode unchanged', () => {
    useUIStore.getState().enterSectionFocus(3, FOCUS_HEIGHT);
    expect(useUIStore.getState().geometryMode).toBe('measured');
  });

  it('exitSectionFocus restores the pre-focus panel layout', () => {
    useUIStore.getState().enterSectionFocus(7, FOCUS_HEIGHT);
    useUIStore.getState().exitSectionFocus();
    const s = useUIStore.getState();
    expect(s.focusedSectionId).toBeNull();
    expect(s.sectionsPanelOpen).toBe(true);
    expect(s.detailPanelOpen).toBe(true);
    expect(s.dataTableOpen).toBe(false);
    expect(s.dataTableHeight).toBe(200);
  });

  it('setFocusedSection follows the selection while focused', () => {
    useUIStore.getState().enterSectionFocus(7, FOCUS_HEIGHT);
    useUIStore.getState().setFocusedSection(9);
    expect(useUIStore.getState().focusedSectionId).toBe(9);
    // panels stay collapsed (it does not re-enter / re-snapshot)
    expect(useUIStore.getState().sectionsPanelOpen).toBe(false);
  });

  it('setFocusedSection is a no-op when not focused', () => {
    useUIStore.getState().setFocusedSection(9);
    expect(useUIStore.getState().focusedSectionId).toBeNull();
  });

  it('re-focusing another section keeps the original pre-focus snapshot', () => {
    useUIStore.getState().enterSectionFocus(7, FOCUS_HEIGHT);
    // simulate a second enter (e.g., via another path) — must not overwrite snapshot
    useUIStore.getState().enterSectionFocus(8, 999);
    useUIStore.getState().exitSectionFocus();
    const s = useUIStore.getState();
    expect(s.sectionsPanelOpen).toBe(true);
    expect(s.dataTableOpen).toBe(false);
    expect(s.dataTableHeight).toBe(200);
  });

  it('a manual panel toggle drops focus mode', () => {
    useUIStore.getState().enterSectionFocus(7, FOCUS_HEIGHT);
    useUIStore.getState().toggleSectionsPanel();
    expect(useUIStore.getState().focusedSectionId).toBeNull();
  });
});
