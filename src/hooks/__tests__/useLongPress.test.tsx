import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { useLongPress } from '../useLongPress';

/**
 * The touch long press behind the sections-panel context menu (#338).
 *
 * `.tsx` so this runs in the jsdom tier (vite.config environmentMatchGlobs):
 * every claim here is about DOM events, and half of them are about events the
 * hook has to keep AWAY from the rest of the document.
 *
 * The harness mirrors the one consumer's shape - handlers spread on a row that
 * has children - because what the finger lands on is a child, not the row.
 */

function Harness({
  onLongPress,
}: {
  onLongPress: (position: { x: number; y: number }, target: HTMLElement) => void;
}) {
  const handlers = useLongPress(onLongPress);
  return (
    <div data-testid="row" {...handlers}>
      <span data-testid="child">row label</span>
    </div>
  );
}

/** A compatibility mouse event of the kind a lift synthesises. */
function compatEvent(target: Element, type: 'mousedown' | 'click'): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

let onDocumentMouseDown: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  // Bubble phase on the document: where the app's dismissable layers listen,
  // and so the thing a swallowed compat mousedown must never reach.
  onDocumentMouseDown = vi.fn();
  document.addEventListener('mousedown', onDocumentMouseDown);
});

afterEach(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown);
  // Disarm anything a test left armed, so it cannot outlive its own file.
  act(() => {
    vi.runOnlyPendingTimers();
  });
  vi.useRealTimers();
});

describe('useLongPress', () => {
  it('fires after the 500 ms hold, with the press position and the element under the finger', () => {
    const onLongPress = vi.fn();
    render(<Harness onLongPress={onLongPress} />);
    const child = screen.getByTestId('child');

    fireEvent.pointerDown(child, { pointerType: 'touch', clientX: 42, clientY: 84 });
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(onLongPress).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress.mock.calls[0]![0]).toEqual({ x: 42, y: 84 });
    // The child, not the row the handlers are bound to: a menu belongs to what
    // the finger actually touched.
    expect(onLongPress.mock.calls[0]![1]).toBe(child);
  });

  it('ignores a mouse press entirely', () => {
    const onLongPress = vi.fn();
    render(<Harness onLongPress={onLongPress} />);
    const child = screen.getByTestId('child');

    fireEvent.pointerDown(child, { pointerType: 'mouse', clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels the press once the finger travels past 10 px', () => {
    const onLongPress = vi.fn();
    render(<Harness onLongPress={onLongPress} />);
    const child = screen.getByTestId('child');

    fireEvent.pointerDown(child, { pointerType: 'touch', clientX: 100, clientY: 100 });
    fireEvent.pointerMove(child, { pointerType: 'touch', clientX: 111, clientY: 100 });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('drops the press on pointercancel', () => {
    const onLongPress = vi.fn();
    render(<Harness onLongPress={onLongPress} />);
    const child = screen.getByTestId('child');

    fireEvent.pointerDown(child, { pointerType: 'touch', clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerCancel(child, { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('keeps the compatibility tap that follows a fired press out of the document', () => {
    const onLongPress = vi.fn();
    render(<Harness onLongPress={onLongPress} />);
    const child = screen.getByTestId('child');

    fireEvent.pointerDown(child, { pointerType: 'touch', clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.pointerUp(child, { pointerType: 'touch', clientX: 10, clientY: 10 });

    compatEvent(child, 'mousedown');
    expect(onDocumentMouseDown).not.toHaveBeenCalled();
    expect(compatEvent(child, 'click').defaultPrevented).toBe(true);
  });

  it('lets the mouse through again once the suppression window expires', () => {
    const onLongPress = vi.fn();
    render(<Harness onLongPress={onLongPress} />);
    const child = screen.getByTestId('child');

    fireEvent.pointerDown(child, { pointerType: 'touch', clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.pointerUp(child, { pointerType: 'touch', clientX: 10, clientY: 10 });

    // Platforms that synthesise nothing leave the window to time out; the app
    // must be usable by mouse the moment it does.
    act(() => {
      vi.advanceTimersByTime(700);
    });
    compatEvent(child, 'mousedown');

    expect(onDocumentMouseDown).toHaveBeenCalledTimes(1);
  });

  it('leaves a short tap alone', () => {
    const onLongPress = vi.fn();
    render(<Harness onLongPress={onLongPress} />);
    const child = screen.getByTestId('child');

    fireEvent.pointerDown(child, { pointerType: 'touch', clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerUp(child, { pointerType: 'touch', clientX: 10, clientY: 10 });
    compatEvent(child, 'mousedown');

    expect(onLongPress).not.toHaveBeenCalled();
    // Tap-to-select rides on the compat mousedown, so a tap must reach it.
    expect(onDocumentMouseDown).toHaveBeenCalledTimes(1);
  });

  it('swallows the tap after a hold far longer than the suppression window', () => {
    // The compat events come from the LIFT, so the window has to be armed
    // there. Armed when the timer fired, a 2 s hold would outlive it and leak
    // the tap into the menu the hold just opened.
    const onLongPress = vi.fn();
    render(<Harness onLongPress={onLongPress} />);
    const child = screen.getByTestId('child');

    fireEvent.pointerDown(child, { pointerType: 'touch', clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);

    fireEvent.pointerUp(child, { pointerType: 'touch', clientX: 10, clientY: 10 });
    compatEvent(child, 'mousedown');

    expect(onDocumentMouseDown).not.toHaveBeenCalled();
  });

  it('re-arms for a second long press', () => {
    const onLongPress = vi.fn();
    render(<Harness onLongPress={onLongPress} />);
    const child = screen.getByTestId('child');

    for (const _pass of [0, 1]) {
      fireEvent.pointerDown(child, { pointerType: 'touch', clientX: 10, clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      fireEvent.pointerUp(child, { pointerType: 'touch', clientX: 10, clientY: 10 });
      compatEvent(child, 'mousedown');
      // The click both ends the tap and closes the window it was armed for.
      expect(compatEvent(child, 'click').defaultPrevented).toBe(true);
    }

    expect(onLongPress).toHaveBeenCalledTimes(2);
    expect(onDocumentMouseDown).not.toHaveBeenCalled();
  });
});
