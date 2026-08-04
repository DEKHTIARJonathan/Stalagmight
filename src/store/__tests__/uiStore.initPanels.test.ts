import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '../uiStore';
import type { PanelsConfig } from '../../types/ipc/PanelsConfig';

/**
 * The default panel layout lives in four places that have to agree: Rust's
 * `PanelsConfig::default()`, its serde field defaults, this store's initial
 * state, and `initPanels`' `??` fallbacks. The Rust side pins its own two; these
 * pin the frontend's.
 *
 * All three panels are open on a fresh install; the data table used to be the
 * odd one out. The fallback is what a config object that bypasses serde - the
 * e2e IPC mock, or an older persisted shape - lands on.
 */

/** A panels payload with the open booleans deliberately absent, as an older
 *  persisted shape or a partial mock would send. */
const withoutOpenFlags = {
  sections_panel_width: 250,
  detail_panel_width: 300,
  data_table_height: 200,
  sections_panel_mode: 'pin',
  detail_panel_mode: 'pin',
  data_table_mode: 'pin',
} as unknown as PanelsConfig;

describe('uiStore panel defaults', () => {
  beforeEach(() => {
    useUIStore.setState({
      sectionsPanelOpen: false,
      detailPanelOpen: false,
      dataTableOpen: false,
    });
  });

  it('starts with the side panels open and the data table closed', () => {
    // The data table's fresh-install default is OPEN, but it is delivered by
    // initPanels below, not here: starting open would mount the heaviest panel
    // in the app on every launch for everyone whose config says closed.
    const initial = useUIStore.getInitialState();
    expect(initial.sectionsPanelOpen).toBe(true);
    expect(initial.detailPanelOpen).toBe(true);
    expect(initial.dataTableOpen).toBe(false);
  });

  it('opens all three when the config omits the open flags', () => {
    useUIStore.getState().initPanels(withoutOpenFlags);
    const s = useUIStore.getState();
    expect(s.sectionsPanelOpen).toBe(true);
    expect(s.detailPanelOpen).toBe(true);
    expect(s.dataTableOpen).toBe(true);
  });

  it('still honours an explicit false - the fallback is only for absent keys', () => {
    useUIStore.getState().initPanels({
      ...withoutOpenFlags,
      sections_panel_open: false,
      detail_panel_open: false,
      data_table_open: false,
    } as PanelsConfig);
    const s = useUIStore.getState();
    expect(s.sectionsPanelOpen).toBe(false);
    expect(s.detailPanelOpen).toBe(false);
    expect(s.dataTableOpen).toBe(false);
  });
});
