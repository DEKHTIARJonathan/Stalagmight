// @vitest-environment jsdom
/**
 * Unit tests for longPressTouch - the shared canvas long-press machine behind
 * the survey and global-view context menus (#338).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachLongPressTouch } from '../longPressTouch';

/**
 * jsdom has `TouchEvent` but no `Touch` constructor, and its `TouchEventInit`
 * accepts plain objects in `touches` - which is all the helper reads off them.
 */
function touchAt(clientX: number, clientY: number): Touch {
  return { identifier: 0, clientX, clientY } as unknown as Touch;
}

function dispatch(target: EventTarget, type: string, touches: Touch[]): TouchEvent {
  const event = new TouchEvent(type, { bubbles: true, cancelable: true, touches });
  target.dispatchEvent(event);
  return event;
}

let target: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  target = document.createElement('div');
  document.body.appendChild(target);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('attachLongPressTouch', () => {
  it('fires the long press after a 500 ms hold, with the touch that started it', () => {
    const onLongPress = vi.fn((_touch: Touch) => true);
    const detach = attachLongPressTouch(target, { onLongPress });

    dispatch(target, 'touchstart', [touchAt(120, 80)]);
    vi.advanceTimersByTime(499);
    expect(onLongPress).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress.mock.calls[0]![0]).toMatchObject({ clientX: 120, clientY: 80 });

    detach();
  });

  it('swallows the touchend that ends a press which opened a menu', () => {
    // The preventDefault is what stops the compatibility mouse events from
    // running the tool underneath the menu that just opened.
    const detach = attachLongPressTouch(target, { onLongPress: () => true });

    dispatch(target, 'touchstart', [touchAt(10, 10)]);
    vi.advanceTimersByTime(500);
    const end = dispatch(target, 'touchend', []);

    expect(end.defaultPrevented).toBe(true);
    detach();
  });

  it('leaves the tap alone when the press opened nothing, or never fired', () => {
    const detach = attachLongPressTouch(target, { onLongPress: () => false });

    dispatch(target, 'touchstart', [touchAt(10, 10)]);
    vi.advanceTimersByTime(500);
    expect(dispatch(target, 'touchend', []).defaultPrevented).toBe(false);

    // A short tap never reaches the callback at all.
    dispatch(target, 'touchstart', [touchAt(10, 10)]);
    vi.advanceTimersByTime(100);
    expect(dispatch(target, 'touchend', []).defaultPrevented).toBe(false);

    detach();
  });

  it('swallows only the touchend of the press that fired', () => {
    const detach = attachLongPressTouch(target, { onLongPress: () => true });

    dispatch(target, 'touchstart', [touchAt(10, 10)]);
    vi.advanceTimersByTime(500);
    expect(dispatch(target, 'touchend', []).defaultPrevented).toBe(true);

    dispatch(target, 'touchstart', [touchAt(10, 10)]);
    vi.advanceTimersByTime(100);
    expect(dispatch(target, 'touchend', []).defaultPrevented).toBe(false);

    detach();
  });

  it('keeps the press alive through a wobble under 10 px', () => {
    const onLongPress = vi.fn(() => true);
    const detach = attachLongPressTouch(target, { onLongPress });

    dispatch(target, 'touchstart', [touchAt(100, 100)]);
    // 6-8-10 triangle: exactly at the threshold, which does not cancel.
    dispatch(target, 'touchmove', [touchAt(106, 108)]);
    vi.advanceTimersByTime(500);

    expect(onLongPress).toHaveBeenCalledTimes(1);
    detach();
  });

  it('cancels the press once the finger travels past 10 px', () => {
    const onLongPress = vi.fn(() => true);
    const detach = attachLongPressTouch(target, { onLongPress });

    dispatch(target, 'touchstart', [touchAt(100, 100)]);
    dispatch(target, 'touchmove', [touchAt(111, 100)]);
    vi.advanceTimersByTime(500);

    expect(onLongPress).not.toHaveBeenCalled();
    expect(dispatch(target, 'touchend', []).defaultPrevented).toBe(false);
    detach();
  });

  it('ignores multi-touch gestures', () => {
    // Two fingers is a pinch, which belongs to MapLibre.
    const onLongPress = vi.fn(() => true);
    const detach = attachLongPressTouch(target, { onLongPress });

    dispatch(target, 'touchstart', [touchAt(10, 10), touchAt(80, 80)]);
    vi.advanceTimersByTime(500);

    expect(onLongPress).not.toHaveBeenCalled();
    detach();
  });

  it('drops a pending press on touchcancel, and clears the swallow flag', () => {
    const onLongPress = vi.fn(() => true);
    const detach = attachLongPressTouch(target, { onLongPress });

    dispatch(target, 'touchstart', [touchAt(10, 10)]);
    vi.advanceTimersByTime(200);
    dispatch(target, 'touchcancel', []);
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();

    // A cancel arriving after a fired press must not leave the next touchend
    // swallowed.
    dispatch(target, 'touchstart', [touchAt(10, 10)]);
    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    dispatch(target, 'touchcancel', []);
    expect(dispatch(target, 'touchend', []).defaultPrevented).toBe(false);

    detach();
  });

  it('does not arm the press while isEnabled says no', () => {
    // The gate is what keeps a hold out of placement mode / a move ghost in
    // flight, whose pointer paths mutate regardless of the swallowed touchend.
    const onLongPress = vi.fn(() => true);
    let enabled = false;
    const detach = attachLongPressTouch(target, { onLongPress, isEnabled: () => enabled });

    dispatch(target, 'touchstart', [touchAt(10, 10)]);
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();

    enabled = true;
    dispatch(target, 'touchstart', [touchAt(10, 10)]);
    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);

    detach();
  });

  it('re-checks isEnabled before firing, since the hold outlasts the check', () => {
    const onLongPress = vi.fn(() => true);
    let enabled = true;
    const detach = attachLongPressTouch(target, { onLongPress, isEnabled: () => enabled });

    dispatch(target, 'touchstart', [touchAt(10, 10)]);
    vi.advanceTimersByTime(400);
    enabled = false;
    vi.advanceTimersByTime(100);

    expect(onLongPress).not.toHaveBeenCalled();
    expect(dispatch(target, 'touchend', []).defaultPrevented).toBe(false);
    detach();
  });

  it('stops listening, and drops a pending press, once detached', () => {
    const onLongPress = vi.fn(() => true);
    const detach = attachLongPressTouch(target, { onLongPress });

    dispatch(target, 'touchstart', [touchAt(10, 10)]);
    vi.advanceTimersByTime(200);
    detach();
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();

    dispatch(target, 'touchstart', [touchAt(10, 10)]);
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
