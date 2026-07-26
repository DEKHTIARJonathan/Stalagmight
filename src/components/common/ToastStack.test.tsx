/**
 * Component test for the toast stack: what renders, the accent per kind, the
 * dwell/fade lifecycle, hover/focus pausing, manual dismiss, and the
 * reduced-motion path.
 *
 * The lifecycle runs on a 50 ms interval, so every timing assertion here uses
 * fake timers - no sleeps, no wall-clock flakes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';

// Initialise the real i18next instance so the dismiss button's accessible name
// is the actual English copy (and this test fails if the key goes missing).
import '../../i18n';
import { ToastStack } from './ToastStack';
import { useUIStore } from '../../store/uiStore';
import { MAX_VISIBLE_TOASTS, TOAST_GAP_PX } from '../../utils/toastCapacity';

/**
 * jsdom has no layout engine: every box measures 0x0, and the stack is now
 * position-driven off measured heights. Stub the measurable box of the toast
 * elements (and only those) so the offsets and the fitted capacity are real
 * numbers rather than a column of zeroes.
 *
 * The stubbed height deliberately differs from the component's
 * ESTIMATED_TOAST_HEIGHT_PX, so an assertion on an offset can only pass if the
 * element was actually measured.
 */
const TOAST_HEIGHT = 60;
const TOAST_WIDTH = 320;
const SLOT = TOAST_HEIGHT + TOAST_GAP_PX;

const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');

function stubLayout() {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset?.toastId ? TOAST_HEIGHT : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset?.toastId ? TOAST_WIDTH : 0;
    },
  });
}

function restoreLayout() {
  if (originalHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalHeight);
  if (originalWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalWidth);
}

/** jsdom's window.innerHeight is 768; the capacity rule needs a known one. */
function setViewportHeight(px: number) {
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: px });
}

function resizeTo(px: number) {
  act(() => {
    setViewportHeight(px);
    window.dispatchEvent(new Event('resize'));
  });
}

/** The `translateY(...)` px value currently applied to a toast. */
const offsetOf = (message: string) => toastFor(message)?.style.transform ?? '';

/** Install a matchMedia stub; jsdom does not provide one. */
function stubReducedMotion(reduce: boolean) {
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduce && query.includes('reduce'),
      media: query,
      onchange: null,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

function push(message: string, key: string, kind?: 'info' | 'success' | 'warning' | 'error') {
  act(() => {
    useUIStore.getState().showToast(message, key, kind);
  });
}

/** Advance the lifecycle clock by `ms`, flushing React updates as it goes. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const toasts = () => screen.queryAllByTestId('toast');
const toastFor = (message: string) =>
  toasts().find((el) => within(el).queryByText(message) !== null);

beforeEach(() => {
  stubReducedMotion(false);
  stubLayout();
  // Tall enough that the 20% budget is not the binding constraint: 5 x 60 plus
  // gaps is 332px, well inside 20% of 2000.
  setViewportHeight(2000);
  vi.useFakeTimers();
  useUIStore.setState({ toasts: [], toastCapacity: MAX_VISIBLE_TOASTS });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  restoreLayout();
  act(() => {
    useUIStore.getState().clearToast();
  });
});

describe('ToastStack - rendering', () => {
  it('renders nothing visible until a toast arrives', () => {
    render(<ToastStack />);
    expect(toasts()).toHaveLength(0);
  });

  it('renders one element per toast, oldest first (so the newest sits at the bottom)', () => {
    render(<ToastStack />);
    push('first', 'a');
    push('second', 'b');
    push('third', 'c');

    expect(toasts().map((el) => el.textContent)).toEqual([
      expect.stringContaining('first'),
      expect.stringContaining('second'),
      expect.stringContaining('third'),
    ]);
  });

  it('shows only the capped set once the stack overflows', () => {
    render(<ToastStack />);
    for (let i = 0; i < 8; i += 1) push(`m${i}`, `k${i}`);

    // A 2000px window has room for the ceiling of five; the rest are evicted and
    // are still playing their exit animation.
    expect(toasts().filter((el) => el.dataset.toastLeaving !== 'true')).toHaveLength(5);

    // The exits finish and the evicted ones are gone.
    advance(300);
    expect(toasts()).toHaveLength(5);
    expect(toastFor('m0')).toBeUndefined();
    expect(toastFor('m7')).toBeDefined();
  });
});

describe('ToastStack - capacity fitted to the window', () => {
  it('caps at five in a tall window', () => {
    render(<ToastStack />);
    for (let i = 0; i < 7; i += 1) push(`m${i}`, `k${i}`);
    advance(300);

    expect(toasts()).toHaveLength(5);
    expect(useUIStore.getState().toastCapacity).toBe(5);
  });

  it('fits fewer toasts in a short window', () => {
    // 20% of 700 is 140px: 60 + 8 + 60 = 128 fits, a third does not.
    setViewportHeight(700);
    render(<ToastStack />);
    for (let i = 0; i < 5; i += 1) push(`m${i}`, `k${i}`);
    advance(300);

    expect(useUIStore.getState().toastCapacity).toBe(2);
    expect(toasts()).toHaveLength(2);
    expect(toastFor('m4')).toBeDefined();
  });

  it('still shows two when two do not fit the budget', () => {
    // 20% of 320 is 64px - room for one 60px toast and no more.
    setViewportHeight(320);
    render(<ToastStack />);
    push('first', 'a');
    push('second', 'b');
    advance(300);

    expect(useUIStore.getState().toastCapacity).toBe(2);
    expect(toasts()).toHaveLength(2);
  });

  it('re-fits on resize, evicting what no longer has room', () => {
    render(<ToastStack />);
    for (let i = 0; i < 5; i += 1) push(`m${i}`, `k${i}`);
    advance(100);
    expect(toasts().filter((el) => el.dataset.toastLeaving !== 'true')).toHaveLength(5);

    resizeTo(700);
    advance(300);

    expect(useUIStore.getState().toastCapacity).toBe(2);
    // The overflow is evicted rather than left off-screen with a live timer.
    expect(toasts()).toHaveLength(2);
    expect(toastFor('m0')).toBeUndefined();
    expect(toastFor('m4')).toBeDefined();
  });

  it('re-fits when the window grows again', () => {
    setViewportHeight(700);
    render(<ToastStack />);
    push('one', 'a');
    advance(100);
    expect(useUIStore.getState().toastCapacity).toBe(2);

    resizeTo(2000);
    advance(100);
    expect(useUIStore.getState().toastCapacity).toBe(5);
  });
});

describe('ToastStack - motion', () => {
  it('positions the newest toast on the anchor and lifts the older ones off it', () => {
    render(<ToastStack />);
    push('older', 'a');
    push('newer', 'b');
    advance(100);

    expect(offsetOf('newer')).toBe('translateY(0px)');
    expect(offsetOf('older')).toBe(`translateY(-${SLOT}px)`);
  });

  it('recomputes every offset when a new toast arrives (the push)', () => {
    render(<ToastStack />);
    push('first', 'a');
    advance(100);
    expect(offsetOf('first')).toBe('translateY(0px)');

    push('second', 'b');
    advance(100);
    expect(offsetOf('first')).toBe(`translateY(-${SLOT}px)`);

    push('third', 'c');
    advance(100);
    expect(offsetOf('first')).toBe(`translateY(-${SLOT * 2}px)`);
    expect(offsetOf('second')).toBe(`translateY(-${SLOT}px)`);
    expect(offsetOf('third')).toBe('translateY(0px)');
  });

  it('uses the MEASURED height rather than a nominal row height', () => {
    render(<ToastStack />);
    push('older', 'a');
    push('newer', 'b');
    advance(100);

    // 68 = the stubbed 60px box plus the 8px gap. A hardcoded row height would
    // put this somewhere else.
    expect(offsetOf('older')).toBe('translateY(-68px)');
  });

  it('closes the gap when a toast in the middle is dismissed', () => {
    render(<ToastStack />);
    push('top', 'a');
    push('middle', 'b');
    push('bottom', 'c');
    advance(100);
    expect(offsetOf('top')).toBe(`translateY(-${SLOT * 2}px)`);

    act(() => {
      within(toastFor('middle')!).getByRole('button').click();
    });

    // The survivor slides down into the freed slot; the leaver drifts up out of
    // its own (it keeps the offset it held, plus the exit lift).
    expect(offsetOf('top')).toBe(`translateY(-${SLOT}px)`);
    expect(offsetOf('middle')).toBe(`translateY(-${SLOT + 12}px)`);
  });

  it('enters from below its slot at zero opacity, then settles into it', () => {
    render(<ToastStack />);
    push('arriving', 'a');

    // First frame: below the slot, invisible.
    expect(offsetOf('arriving')).toBe('translateY(12px)');
    expect(toastFor('arriving')?.style.opacity).toBe('0');

    advance(100);
    expect(offsetOf('arriving')).toBe('translateY(0px)');
    expect(toastFor('arriving')?.style.opacity).toBe('1');
  });

  it('keeps a leaving toast mounted for the exit, drifting up, then removes it', () => {
    render(<ToastStack />);
    push('bye', 'a');
    advance(100);

    act(() => {
      within(toastFor('bye')!).getByRole('button').click();
    });

    // Still mounted, above its slot, transparent.
    expect(toastFor('bye')).toBeDefined();
    expect(toastFor('bye')?.dataset.toastLeaving).toBe('true');
    expect(offsetOf('bye')).toBe('translateY(-12px)');
    expect(toastFor('bye')?.style.opacity).toBe('0');

    // Part-way through the 180ms exit it is still there.
    advance(100);
    expect(toastFor('bye')).toBeDefined();

    // Past it, gone.
    advance(150);
    expect(toastFor('bye')).toBeUndefined();
  });

  it('carries a transition so the offsets animate rather than jump', () => {
    render(<ToastStack />);
    push('moving', 'a');
    advance(100);

    const el = toastFor('moving');
    expect(el?.className).toContain('transition-[opacity,transform]');
    expect(el?.style.transitionDuration).toBe('180ms');
  });
});

describe('ToastStack - accents per kind', () => {
  it.each([
    ['success', 'border-success', 'bg-success-10'],
    ['warning', 'border-warning', 'bg-warning-10'],
    ['error', 'border-error', 'bg-error-10'],
  ] as const)('%s carries its theme-token accent', (kind, border, tint) => {
    render(<ToastStack />);
    push('accented', 'k', kind);

    const el = toastFor('accented');
    expect(el?.dataset.toastKind).toBe(kind);
    const body = el?.querySelector('div');
    expect(body?.className).toContain(border);
    expect(body?.className).toContain(tint);
  });

  it('info keeps the neutral look - no accent tint', () => {
    render(<ToastStack />);
    push('neutral', 'k');

    const el = toastFor('neutral');
    expect(el?.dataset.toastKind).toBe('info');
    const body = el?.querySelector('div');
    expect(body?.className).not.toMatch(/bg-(success|warning|error)-10/);
  });
});

describe('ToastStack - lifecycle', () => {
  it('holds full opacity through the dwell, then fades, then removes itself', () => {
    render(<ToastStack />);
    push('temporary', 'k');

    advance(4000);
    expect(toastFor('temporary')?.style.opacity).toBe('1');

    // Into the fade: still on screen, but no longer fully opaque.
    advance(2000);
    const midFade = Number(toastFor('temporary')?.style.opacity);
    expect(midFade).toBeGreaterThan(0);
    expect(midFade).toBeLessThan(1);

    // Past dwell + fade.
    advance(1000);
    expect(toastFor('temporary')).toBeUndefined();
    expect(useUIStore.getState().toasts).toHaveLength(0);
  });

  it('gives an error a longer dwell than a success', () => {
    render(<ToastStack />);
    push('went well', 'ok', 'success');
    push('went badly', 'bad', 'error');

    // Past the success lifetime (5s dwell + 1.5s fade) but not the error's.
    advance(6600);
    expect(toastFor('went well')).toBeUndefined();
    expect(toastFor('went badly')).toBeDefined();
    expect(toastFor('went badly')?.style.opacity).toBe('1');

    advance(4000);
    expect(toastFor('went badly')).toBeUndefined();
  });

  it('restarts the clock when the same key refreshes the toast', () => {
    render(<ToastStack />);
    push('attempt one', 'dup');

    advance(4000);
    push('attempt two', 'dup');

    // Without the reset this would already be past its lifetime.
    advance(4000);
    expect(toastFor('attempt two')?.style.opacity).toBe('1');
    expect(toasts()).toHaveLength(1);
  });
});

describe('ToastStack - pausing', () => {
  it('hover pauses dismissal and restores full opacity', () => {
    render(<ToastStack />);
    push('read me', 'k');

    // Let it start fading.
    advance(5500);
    expect(Number(toastFor('read me')?.style.opacity)).toBeLessThan(1);

    act(() => {
      screen.getByTestId('toast-stack').dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    expect(toastFor('read me')?.style.opacity).toBe('1');

    // Well past its lifetime, but frozen.
    advance(20000);
    expect(toastFor('read me')).toBeDefined();
    expect(toastFor('read me')?.style.opacity).toBe('1');
  });

  it('resumes from where it stopped on mouse-out', () => {
    render(<ToastStack />);
    push('read me', 'k');

    advance(5500);
    const stack = screen.getByTestId('toast-stack');
    act(() => {
      stack.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    advance(20000);
    act(() => {
      stack.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });

    // Only ~1s of the 1.5s fade remained, so it is still here but fading again.
    advance(500);
    expect(Number(toastFor('read me')?.style.opacity)).toBeLessThan(1);
    advance(1200);
    expect(toastFor('read me')).toBeUndefined();
  });

  it('keyboard focus pauses the stack too', () => {
    render(<ToastStack />);
    push('read me', 'k');

    advance(5500);
    act(() => {
      screen.getAllByRole('button')[0]?.focus();
    });

    expect(toastFor('read me')?.style.opacity).toBe('1');
    advance(20000);
    expect(toastFor('read me')).toBeDefined();
  });

  it('pausing is stack-wide, so the column cannot reshuffle under the pointer', () => {
    render(<ToastStack />);
    push('older', 'a');
    push('newer', 'b');

    act(() => {
      screen.getByTestId('toast-stack').dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    advance(30000);

    expect(toasts().map((el) => el.dataset.toastKey)).toEqual(['a', 'b']);
  });
});

describe('ToastStack - manual dismiss', () => {
  it('removes only the dismissed toast', () => {
    render(<ToastStack />);
    push('keep me', 'a');
    push('drop me', 'b');

    const dismiss = within(toastFor('drop me')!).getByRole('button');
    act(() => {
      dismiss.click();
    });
    advance(300);

    expect(toastFor('drop me')).toBeUndefined();
    expect(toastFor('keep me')).toBeDefined();
  });

  it('does not leave the stack stuck paused after the last toast is dismissed', () => {
    render(<ToastStack />);
    push('only one', 'a');

    // Hover, then dismiss the last toast: the container unmounts, so its
    // mouseleave never fires.
    act(() => {
      screen.getByTestId('toast-stack').dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    act(() => {
      within(toastFor('only one')!).getByRole('button').click();
    });
    advance(300);
    expect(toasts()).toHaveLength(0);

    // The next toast must still expire on its own.
    push('a later one', 'b');
    advance(7000);
    expect(toastFor('a later one')).toBeUndefined();
  });

  it('the dismiss control is a real button with an accessible name', () => {
    render(<ToastStack />);
    push('something happened', 'a');

    const button = within(toastFor('something happened')!).getByRole('button');
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAccessibleName(/something happened/);
  });
});

describe('ToastStack - accessibility', () => {
  it('announces info/success politely and error/warning assertively', () => {
    render(<ToastStack />);
    push('all good', 'a', 'success');
    push('it broke', 'b', 'error');

    expect(screen.getByRole('status')).toHaveTextContent('all good');
    expect(screen.getByRole('alert')).toHaveTextContent('it broke');
  });

  it('mounts both live regions before any toast exists', () => {
    render(<ToastStack />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('ToastStack - prefers-reduced-motion', () => {
  it('skips the animation and the fade, but keeps the same lifetime', () => {
    stubReducedMotion(true);
    render(<ToastStack />);
    push('no motion please', 'k');

    const el = toastFor('no motion please');
    expect(el?.className).not.toContain('animate-toast-in');
    expect(el?.className).not.toContain('transition-');

    // Full opacity right through what would have been the fade.
    advance(6000);
    expect(toastFor('no motion please')?.style.opacity).toBe('1');

    // Then it simply disappears at the end of its (unchanged) lifetime.
    advance(600);
    expect(toastFor('no motion please')).toBeUndefined();
  });

  it('snaps straight to its slot - no entrance travel, no exit drift', () => {
    stubReducedMotion(true);
    render(<ToastStack />);
    push('older', 'a');
    push('newer', 'b');

    // No entrance offset even on the very first frame, and full opacity at once.
    expect(offsetOf('newer')).toBe('translateY(0px)');
    expect(toastFor('newer')?.style.opacity).toBe('1');

    advance(100);
    expect(offsetOf('older')).toBe(`translateY(-${SLOT}px)`);

    // Dismissing places it nowhere new: it is simply taken away.
    act(() => {
      within(toastFor('newer')!).getByRole('button').click();
    });
    expect(offsetOf('newer')).toBe('translateY(0px)');
  });

  it('keeps the fitted capacity - reduced motion is about movement, not count', () => {
    stubReducedMotion(true);
    setViewportHeight(700);
    render(<ToastStack />);
    for (let i = 0; i < 5; i += 1) push(`m${i}`, `k${i}`);
    advance(300);

    expect(useUIStore.getState().toastCapacity).toBe(2);
    expect(toasts()).toHaveLength(2);
  });
});
