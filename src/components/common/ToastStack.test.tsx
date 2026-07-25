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
  vi.useFakeTimers();
  useUIStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
    for (let i = 0; i < 6; i += 1) push(`m${i}`, `k${i}`);

    // 4 live plus the 2 evicted still playing their exit animation.
    expect(toasts().length).toBeLessThanOrEqual(6);
    expect(toasts().filter((el) => el.dataset.toastLeaving !== 'true')).toHaveLength(4);

    // The exit finishes and the evicted pair is gone.
    advance(300);
    expect(toasts()).toHaveLength(4);
    expect(toastFor('m0')).toBeUndefined();
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
});
