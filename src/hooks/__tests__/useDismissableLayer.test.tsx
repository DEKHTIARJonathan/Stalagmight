import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { RefObject } from 'react';
import { useDismissableLayer } from '../useDismissableLayer';

/**
 * Contract this pins, in two layers.
 *
 * 1. (Relied on by Select's fix for #268) a scroll whose target is a `scrollSafe`
 *    element does NOT dismiss. Select marks the trigger's own scroll container
 *    scroll-safe so the focus-into-view scroll that opening triggers can't
 *    self-dismiss the dropdown.
 * 2. Of the rest, only scrolls that can actually MOVE the layer dismiss it: the page
 *    itself, and ancestors of the layer or its trigger. A scroll in an unrelated
 *    subtree is ignored - a map right-click used to close its own context menu
 *    because selecting the station scrolled the data table and the sections panel.
 */

const ref = <T extends HTMLElement>(el: T | null): RefObject<T | null> => ({ current: el });

describe('useDismissableLayer', () => {
  let panel: HTMLDivElement; // the trigger's scroll container
  let trigger: HTMLButtonElement;
  let dropdown: HTMLDivElement; // the portaled surface
  let onDismiss: MockInstance;

  beforeEach(() => {
    panel = document.createElement('div');
    trigger = document.createElement('button');
    panel.appendChild(trigger);
    dropdown = document.createElement('div');
    document.body.append(panel, dropdown);
    onDismiss = vi.fn();
  });

  afterEach(() => {
    panel.remove();
    dropdown.remove();
  });

  const mount = (scrollSafe?: HTMLElement[]) =>
    renderHook(() =>
      useDismissableLayer({
        open: true,
        onDismiss: onDismiss as unknown as () => void,
        contains: [ref(trigger), ref(dropdown)],
        ...(scrollSafe ? { scrollSafe: scrollSafe.map(ref) } : {}),
      }),
    );

  it('dismisses on a scroll of an ancestor outside the safe set', () => {
    mount([dropdown]);
    document.body.dispatchEvent(new Event('scroll')); // body is an ancestor of both refs
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses when the scroll is inside anchorScope, even though the layer is not', () => {
    // The DataTable header/connection menus: pinned to cursor coordinates and
    // rendered as a `position:fixed` SIBLING of the grid, so the grid scroll that
    // strands them contains neither the menu nor the page. Without anchorScope
    // the ancestor test cannot see this, and the menu floats over a header that
    // scrolled away.
    const panel = document.createElement('div');
    const scroller = document.createElement('div');
    panel.appendChild(scroller); // the grid, inside the panel
    panel.appendChild(dropdown); // the fixed menu, a sibling of the grid
    document.body.appendChild(panel);
    renderHook(() =>
      useDismissableLayer({
        open: true,
        onDismiss: onDismiss as unknown as () => void,
        contains: [ref(dropdown)],
        anchorScope: ref(panel),
      }),
    );
    scroller.dispatchEvent(new Event('scroll'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    panel.remove();
  });

  it('ignores an anchorScope the host did not supply', () => {
    // The map's context menu passes no scope, so no panel scrolling elsewhere can
    // close it - the property the shared menu depends on for map right-clicks.
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    renderHook(() =>
      useDismissableLayer({
        open: true,
        onDismiss: onDismiss as unknown as () => void,
        contains: [ref(dropdown)],
        anchorScope: ref(null),
      }),
    );
    elsewhere.dispatchEvent(new Event('scroll'));
    expect(onDismiss).not.toHaveBeenCalled();
    elsewhere.remove();
  });

  it('does NOT dismiss when an unrelated subtree scrolls', () => {
    // The map context-menu bug: right-clicking a station scrolls the data table
    // and the sections panel, neither of which can move a menu portaled elsewhere.
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    mount([dropdown]);
    elsewhere.dispatchEvent(new Event('scroll'));
    expect(onDismiss).not.toHaveBeenCalled();
    elsewhere.remove();
  });

  it('does NOT dismiss when the trigger container is scroll-safe and it scrolls', () => {
    mount([dropdown, panel]); // Select's fix: trigger's scroll ancestor marked safe
    panel.dispatchEvent(new Event('scroll'));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('still dismisses on a window/page scroll even when the container is scroll-safe', () => {
    mount([dropdown, panel]);
    window.dispatchEvent(new Event('scroll')); // target is window, not an element ancestor
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses on resize', () => {
    mount([dropdown, panel]);
    window.dispatchEvent(new Event('resize'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses on outside mousedown but not on inside mousedown', () => {
    mount([dropdown]);
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('attaches no listeners while closed', () => {
    renderHook(() =>
      useDismissableLayer({
        open: false,
        onDismiss: onDismiss as unknown as () => void,
        contains: [ref(trigger)],
      }),
    );
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
