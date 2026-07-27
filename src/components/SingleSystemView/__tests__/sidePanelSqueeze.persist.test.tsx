import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useSidePanelSqueeze, acceptsResize } from '../sidePanelSqueeze';
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

/**
 * The same rule from the other direction, and the way it was actually broken:
 * the squeeze was kept out of the store, but a resize DRAG routed it back in.
 *
 * A Dock renders at the squeezed width, so `useResizeHandle` measures the
 * squeezed panel. Widening it produced sizes above the clamp that the squeeze
 * re-applied on the same frame - the edge never moved - and `onResize` /
 * `onResizeEnd` wrote them anyway. A panel squeezed from 400px to its 200px
 * minimum therefore looked inert to drag, and then came back at the dragged width
 * instead of 400 once the user returned to 100% zoom: a silent, unattributable
 * loss of their layout.
 */
describe('acceptsResize - a squeezed drag cannot raise the persisted size', () => {
  const USER = 400;
  const SQUEEZED = 200;

  it('accepts anything while the panel renders at the user\'s own size', () => {
    expect(acceptsResize(USER, USER, 500)).toBe(true);
    expect(acceptsResize(USER, USER, 250)).toBe(true);
  });

  it('refuses a size the squeezed rendering could never have reached', () => {
    // The whole widening direction: the first pixel of drag already exceeds the
    // clamp, so every one of these is a width the edge did not move to.
    expect(acceptsResize(SQUEEZED, USER, SQUEEZED + 1)).toBe(false);
    expect(acceptsResize(SQUEEZED, USER, 300)).toBe(false);
    expect(acceptsResize(SQUEEZED, USER, USER + 100)).toBe(false);
  });

  it('still accepts a shrink, which IS reachable while squeezed', () => {
    // A smaller panel is always affordable, so dragging one narrower is a real
    // request and must persist - refusing it would make a squeezed panel
    // un-resizable in both directions rather than one.
    expect(acceptsResize(SQUEEZED, USER, SQUEEZED)).toBe(true);
    expect(acceptsResize(SQUEEZED, USER, 150)).toBe(true);
  });
});
