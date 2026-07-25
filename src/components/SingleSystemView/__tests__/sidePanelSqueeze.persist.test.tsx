import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useSidePanelSqueeze } from '../sidePanelSqueeze';
import { MAP_MIN_WIDTH, PANEL_SIZE_BOUNDS } from '../layoutConstants';
import { BAR } from '../Dock';
import { useUIStore } from '../../../store/uiStore';

// `.tsx` so this runs in the jsdom tier (vite.config environmentMatchGlobs).

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/ipc', () => ({ invokeIpc: invokeIpcMock }));

/**
 * The single most dangerous way to get #260 wrong: routing the viewport-driven
 * squeeze back through the resize path. A temporary 150px squeeze persisted to
 * config would leave the panel tiny FOREVER once the user zoomed back out - a
 * worse bug than the one being fixed, and an invisible one (it only shows on the
 * next launch). These tests pin that the squeeze is display-only: the store's
 * width fields and the `update_panel_sizes` IPC must both be untouched no matter
 * how narrow the container gets.
 */

/** A detached div reporting a fixed width (jsdom has no layout). */
function containerOfWidth(width: number): HTMLDivElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return el;
}

const USER_SECTIONS = 284;
const USER_DETAIL = 282;

function squeezeOpts() {
  return {
    mapMinWidth: MAP_MIN_WIDTH,
    barWidth: BAR,
    sections: {
      width: USER_SECTIONS,
      min: PANEL_SIZE_BOUNDS.sections.min,
      present: true,
      pinnedOpen: true,
    },
    detail: {
      width: USER_DETAIL,
      min: PANEL_SIZE_BOUNDS.detail.min,
      present: true,
      pinnedOpen: true,
    },
  };
}

describe('useSidePanelSqueeze - the squeeze never reaches the persisted store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeIpcMock.mockResolvedValue(undefined);
    useUIStore.setState({ sectionsPanelWidth: USER_SECTIONS, detailPanelWidth: USER_DETAIL });
  });

  it('squeezes the rendered widths while leaving the store widths and the persist IPC alone', () => {
    // The measured 250%-zoom case: a squeeze AND a Details collapse.
    const { result } = renderHook(() =>
      useSidePanelSqueeze(containerOfWidth(614), squeezeOpts()),
    );

    expect(result.current.sections.width).toBeLessThan(USER_SECTIONS);
    expect(result.current.detail.collapsed).toBe(true);

    // The user's own widths are exactly as they left them...
    expect(useUIStore.getState().sectionsPanelWidth).toBe(USER_SECTIONS);
    expect(useUIStore.getState().detailPanelWidth).toBe(USER_DETAIL);
    // ...and nothing was written to config (savePanelSizes / savePanelLayout are
    // the only writers, and both go through invokeIpc).
    expect(invokeIpcMock).not.toHaveBeenCalled();
  });

  it('writes nothing even when the container collapses to nearly zero', () => {
    const { rerender } = renderHook(
      ({ width }: { width: number }) => useSidePanelSqueeze(containerOfWidth(width), squeezeOpts()),
      { initialProps: { width: 1600 } },
    );

    for (const width of [900, 700, 614, 400, 120, 1]) rerender({ width });

    expect(useUIStore.getState().sectionsPanelWidth).toBe(USER_SECTIONS);
    expect(useUIStore.getState().detailPanelWidth).toBe(USER_DETAIL);
    expect(invokeIpcMock).not.toHaveBeenCalled();
  });

  it('hands the user their widths back when the container grows again', () => {
    const { result, rerender } = renderHook(
      ({ width }: { width: number }) => useSidePanelSqueeze(containerOfWidth(width), squeezeOpts()),
      { initialProps: { width: 400 } },
    );

    expect(result.current.sections.collapsed).toBe(true);
    expect(result.current.detail.collapsed).toBe(true);

    rerender({ width: 1600 });

    expect(result.current).toEqual({
      sections: { width: USER_SECTIONS, collapsed: false },
      detail: { width: USER_DETAIL, collapsed: false },
    });
    expect(invokeIpcMock).not.toHaveBeenCalled();
  });
});
