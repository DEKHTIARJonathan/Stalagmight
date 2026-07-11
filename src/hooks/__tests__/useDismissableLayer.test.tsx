import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { RefObject } from 'react';
import { useDismissableLayer } from '../useDismissableLayer';

/**
 * Contract this pins (relied on by Select's fix for #268): a scroll whose target is a
 * `scrollSafe` element does NOT dismiss, while an external/page scroll (window, or an
 * element outside the safe set) DOES. Select marks the trigger's own scroll container
 * scroll-safe so the focus-into-view scroll that opening triggers can't self-dismiss the
 * dropdown, without weakening dismissal on a genuine outside scroll.
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

  it('dismisses on a scroll outside the safe set', () => {
    mount([dropdown]);
    document.body.dispatchEvent(new Event('scroll'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
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
