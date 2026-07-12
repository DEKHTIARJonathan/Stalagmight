/**
 * Regression test (#289): DialogWrapper's initial-focus heuristic runs in a
 * requestAnimationFrame after mount. It must NOT steal focus from a control
 * the user already focused inside the dialog - under jsdom's ~16ms rAF the
 * callback fired mid-userEvent.type(), blurred the input between the click
 * and the keystroke, and the typed text was lost (the flaky
 * SectionAdjustDialog "can clear a typed value" failure).
 *
 * The rAF is stubbed and fired by hand so both orderings are deterministic
 * (prove-the-guard-via-injection): with focus on an inner control the
 * heuristic must yield; with only the container-level default focus it must
 * still run. In jsdom every candidate fails the getClientRects() visibility
 * check, so a heuristic that runs always lands on Priority 5, the close X
 * button - which is exactly what the pre-fix focus steal looked like.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DialogWrapper } from './DialogWrapper';

let rafCallbacks: FrameRequestCallback[];

beforeEach(() => {
  rafCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDialog() {
  render(
    <DialogWrapper title="Focus test" onClose={() => {}}>
      <input data-testid="first-input" />
      <input data-testid="second-input" />
    </DialogWrapper>,
  );
}

describe('DialogWrapper initial-focus rAF (#289)', () => {
  it('does not steal focus from a control already focused inside the dialog', () => {
    renderDialog();
    const second = screen.getByTestId('second-input');
    second.focus();
    expect(second).toHaveFocus();

    rafCallbacks.forEach((cb) => cb(0)); // the mount rAF fires mid-interaction

    expect(second).toHaveFocus(); // pre-fix: yanked to the close X button
  });

  it('still places initial focus when only the container default is focused', () => {
    renderDialog();
    // The mount layout effect focused the outer dialog container; no user
    // focus happened before the first frame.
    expect(document.activeElement?.getAttribute('data-testid')).not.toBe('second-input');

    rafCallbacks.forEach((cb) => cb(0));

    // The heuristic ran: in jsdom every visibility-checked candidate fails
    // getClientRects(), so it lands on the Priority 5 close button. The exact
    // target matters less than that focus moved off the container at all.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close dialog');
  });
});
