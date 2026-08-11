/**
 * Component test - the wizard map column's divider (#567 item 5).
 *
 * Nothing covered `WizardMapPanel` itself: every dialog test that renders a
 * wizard `vi.mock`s this module away (it pulls the MapLibre preview), so the
 * divider's behavior was only ever exercised by hand. That is now load-bearing,
 * because the divider is the first resizer in the app with a keyboard path and
 * the shape here is the precedent for #396.
 *
 * What each test would catch if the keyboard path regressed is spelled out per
 * case; the common thread is that a keyboard resize must be indistinguishable
 * from a drag downstream - same clamp, same `savePanelSizes('wizard-map', n)` -
 * while never issuing one config write per keypress.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { useRef, useState } from 'react';

// The real i18n instance: the divider's accessible name is a key, and a test
// against an uninitialised instance would assert on `[key]` echoes.
import '../../../i18n';
import { WizardMapPanel, MAP_PANEL_MIN_WIDTH, MAP_PANEL_MAX_WIDTH } from '../WizardMapPanel';
import { useUIStore } from '../../../store/uiStore';

const DEFAULT_WIDTH = 480;
const STEP = 16;
const COARSE_STEP = 64;
const PERSIST_DELAY_MS = 300;

/**
 * The panel is controlled: the wizard owns the width and feeds it back. Mirror
 * that here so `aria-valuenow` is asserted on the value that actually round
 * trips, not on the prop the test passed in.
 */
function Harness({ initialWidth = DEFAULT_WIDTH }: { initialWidth?: number }) {
  const [width, setWidth] = useState(initialWidth);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={bodyRef} data-testid="body">
      <WizardMapPanel
        width={width}
        height={600}
        onWidthChange={(next) => {
          widthChanges.push(next);
          setWidth(next);
        }}
        bodyRef={bodyRef}
        panelRef={() => {}}
      >
        <div data-testid="preview" />
      </WizardMapPanel>
    </div>
  );
}

let widthChanges: number[] = [];
let savePanelSizes: ReturnType<typeof vi.fn>;
const realSavePanelSizes = useUIStore.getState().savePanelSizes;

const divider = () => screen.getByTestId('wizard-map-resize');
/** Latest width the panel handed back (the tsconfig lib predates Array#at). */
const lastWidth = () => widthChanges[widthChanges.length - 1];

// jsdom has no pointer capture, which useResizeHandle takes on pointerdown.
const pointerCaptureHost = Element.prototype as unknown as {
  setPointerCapture?: (pointerId: number) => void;
};

beforeEach(() => {
  vi.useFakeTimers();
  widthChanges = [];
  savePanelSizes = vi.fn(async () => {});
  useUIStore.setState({ savePanelSizes });
  pointerCaptureHost.setPointerCapture = () => {};
});

afterEach(() => {
  // Unmount BEFORE restoring the store. The panel flushes a pending width on
  // unmount (that is the point of the flush), so a store restored first would
  // route that write to the real savePanelSizes and its Tauri IPC call.
  cleanup();
  vi.useRealTimers();
  useUIStore.setState({ savePanelSizes: realSavePanelSizes });
  delete pointerCaptureHost.setPointerCapture;
});

describe('WizardMapPanel divider - ARIA', () => {
  it('is a focusable window splitter reporting the current width in the drag range', () => {
    render(<Harness />);
    const el = divider();

    expect(el).toHaveAttribute('role', 'separator');
    expect(el).toHaveAttribute('aria-orientation', 'vertical');
    expect(el).toHaveAttribute('aria-valuenow', String(DEFAULT_WIDTH));
    expect(el).toHaveAttribute('aria-valuemin', String(MAP_PANEL_MIN_WIDTH));
    expect(el).toHaveAttribute('aria-valuemax', String(MAP_PANEL_MAX_WIDTH));
    // Named, or a screen reader announces a bare "separator" with a number.
    expect(el).toHaveAccessibleName('Resize map panel');

    // Tabbable, not just focusable-by-script: a pointer-only divider is exactly
    // what #567 item 5 reported.
    expect(el).toHaveAttribute('tabindex', '0');
    el.focus();
    expect(document.activeElement).toBe(el);
  });
});

describe('WizardMapPanel divider - keyboard resize', () => {
  it('nudges by a step with the arrows, and by a coarse step with Shift', () => {
    render(<Harness />);

    fireEvent.keyDown(divider(), { key: 'ArrowRight' });
    expect(widthChanges).toEqual([DEFAULT_WIDTH + STEP]);
    expect(divider()).toHaveAttribute('aria-valuenow', String(DEFAULT_WIDTH + STEP));

    fireEvent.keyDown(divider(), { key: 'ArrowLeft' });
    expect(lastWidth()).toBe(DEFAULT_WIDTH);

    fireEvent.keyDown(divider(), { key: 'ArrowRight', shiftKey: true });
    expect(lastWidth()).toBe(DEFAULT_WIDTH + COARSE_STEP);
    expect(divider()).toHaveAttribute('aria-valuenow', String(DEFAULT_WIDTH + COARSE_STEP));
  });

  it('jumps to the bounds with Home and End', () => {
    render(<Harness />);

    fireEvent.keyDown(divider(), { key: 'End' });
    expect(lastWidth()).toBe(MAP_PANEL_MAX_WIDTH);
    expect(divider()).toHaveAttribute('aria-valuenow', String(MAP_PANEL_MAX_WIDTH));

    fireEvent.keyDown(divider(), { key: 'Home' });
    expect(lastWidth()).toBe(MAP_PANEL_MIN_WIDTH);
    expect(divider()).toHaveAttribute('aria-valuenow', String(MAP_PANEL_MIN_WIDTH));
  });

  it('clamps at the bounds instead of stepping past them', () => {
    render(<Harness initialWidth={MAP_PANEL_MAX_WIDTH - STEP / 2} />);

    // Overshoot lands ON the bound, not past it.
    fireEvent.keyDown(divider(), { key: 'ArrowRight' });
    expect(widthChanges).toEqual([MAP_PANEL_MAX_WIDTH]);

    // At the bound the key is a no-op: no re-render of the wizard body, and
    // nothing scheduled to persist.
    fireEvent.keyDown(divider(), { key: 'ArrowRight', shiftKey: true });
    expect(widthChanges).toEqual([MAP_PANEL_MAX_WIDTH]);
    act(() => void vi.advanceTimersByTime(PERSIST_DELAY_MS));
    expect(savePanelSizes).toHaveBeenCalledTimes(1);
    expect(savePanelSizes).toHaveBeenCalledWith('wizard-map', MAP_PANEL_MAX_WIDTH);
  });

  it('ignores keys that are not resize keys', () => {
    render(<Harness />);

    fireEvent.keyDown(divider(), { key: 'Enter' });
    fireEvent.keyDown(divider(), { key: 'a' });
    fireEvent.keyDown(divider(), { key: 'ArrowUp' });

    expect(widthChanges).toEqual([]);
    act(() => void vi.advanceTimersByTime(PERSIST_DELAY_MS));
    expect(savePanelSizes).not.toHaveBeenCalled();
  });
});

describe('WizardMapPanel divider - persistence', () => {
  it('persists a burst of keys exactly once, after the burst settles', () => {
    render(<Harness />);

    fireEvent.keyDown(divider(), { key: 'ArrowRight' });
    fireEvent.keyDown(divider(), { key: 'ArrowRight' });
    fireEvent.keyDown(divider(), { key: 'ArrowRight' });

    // Per-keypress persistence would be three config round-trips by now.
    expect(savePanelSizes).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(PERSIST_DELAY_MS - 1));
    expect(savePanelSizes).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(1));
    expect(savePanelSizes).toHaveBeenCalledTimes(1);
    expect(savePanelSizes).toHaveBeenCalledWith('wizard-map', DEFAULT_WIDTH + 3 * STEP);
  });

  it('flushes a width still inside the debounce window when the wizard closes', () => {
    const view = render(<Harness />);

    fireEvent.keyDown(divider(), { key: 'ArrowRight' });
    expect(savePanelSizes).not.toHaveBeenCalled();

    // Escape/Cancel right after a nudge - the pending width must not be lost.
    act(() => view.unmount());

    expect(savePanelSizes).toHaveBeenCalledTimes(1);
    expect(savePanelSizes).toHaveBeenCalledWith('wizard-map', DEFAULT_WIDTH + STEP);

    // ...and the flushed timer must not fire a second write.
    act(() => void vi.advanceTimersByTime(PERSIST_DELAY_MS));
    expect(savePanelSizes).toHaveBeenCalledTimes(1);
  });

  it('lets a drag that lands mid-debounce win over the pending keyboard width', () => {
    render(<Harness />);

    fireEvent.keyDown(divider(), { key: 'ArrowRight' });

    // jsdom rects are all zeros, so the drag width is the release clientX.
    fireEvent.pointerDown(divider(), { pointerId: 1 });
    fireEvent.pointerMove(divider(), { pointerId: 1, clientX: 640 });
    fireEvent.pointerUp(divider(), { pointerId: 1, clientX: 640 });

    expect(lastWidth()).toBe(640);
    expect(savePanelSizes).toHaveBeenCalledTimes(1);
    expect(savePanelSizes).toHaveBeenCalledWith('wizard-map', 640);

    // The older keyboard width must not land on top of the drag.
    act(() => void vi.advanceTimersByTime(PERSIST_DELAY_MS));
    expect(savePanelSizes).toHaveBeenCalledTimes(1);
  });
});
