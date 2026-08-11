/**
 * Component test - the wizard preview fills its column (#567 item 1).
 *
 * The hook used to return the side of the largest SQUARE that fit, which is what
 * made the divider's upper range pointless: past the crossover where the column
 * is wider than the band is tall, the square is pinned by the height and every
 * further pixel of column is dead space either side of it. The regression these
 * tests exist to catch is a return to that - a single measurement used for both
 * axes - so the load-bearing assertion is that widening a SHORT column keeps
 * buying preview width.
 *
 * jsdom has no layout, so the container's client box is stubbed and the
 * ResizeObserver is a hand-fired double; the arithmetic under test is the
 * hook's, not the browser's.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, act } from '@testing-library/react';
import { useCallback } from 'react';

import { usePreviewSize } from '../usePreviewSize';

/** The wizards pass the map column's own max width as the preview cap. */
const MAX = 900;
const MIN = 240;
/** The panel's `p-4` - 16px per side, so 32 off each axis. */
const PADDING = 32;

/** Mutable client box the stubbed container reports. */
const box = { width: 0, height: 0 };

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(private readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  disconnect() {}
  fire() {
    this.callback();
  }
}

/** Re-measure the way a divider drag or a window resize does. */
function resizeTo(width: number, height: number) {
  box.width = width;
  box.height = height;
  act(() => {
    for (const observer of FakeResizeObserver.instances) observer.fire();
  });
}

/** Every size the hook has handed out, newest last, identity preserved. */
let sizes: ReturnType<typeof usePreviewSize>[1][] = [];

function Harness() {
  const [previewRef, size] = usePreviewSize(MAX);
  sizes.push(size);
  // Stub the client box before the hook's ref callback measures it.
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) {
        Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => box.width });
        Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box.height });
      }
      previewRef(el);
    },
    [previewRef],
  );
  return (
    <div ref={attach} data-testid="panel">
      <div data-testid="preview" data-width={size.width} data-height={size.height} />
    </div>
  );
}

const preview = () => screen.getByTestId('preview');
const previewWidth = () => Number(preview().getAttribute('data-width'));
const previewHeight = () => Number(preview().getAttribute('data-height'));

const realResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  FakeResizeObserver.instances = [];
  sizes = [];
  box.width = 0;
  box.height = 0;
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver;
});

describe('usePreviewSize', () => {
  it('seeds at the minimum, so the frame before the first measurement cannot overflow', () => {
    // Nothing attached yet: this is what a caller renders with on frame one.
    // At `max` that frame is a 900px box inside a ~600px column.
    const { result } = renderHook(() => usePreviewSize(MAX));

    expect(result.current[1]).toEqual({ width: MIN, height: MIN });
  });

  it('fills both axes of the column, not the smaller one twice', () => {
    render(<Harness />);
    // A wide, short column: 1024x640 window, divider dragged near its 900 max.
    resizeTo(880, 600);

    expect(previewWidth()).toBe(880 - PADDING);
    expect(previewHeight()).toBe(600 - PADDING);
  });

  it('keeps buying preview width past the point where the height binds', () => {
    render(<Harness />);
    // The crossover on a 640px-tall window: at 500 the column is already
    // narrower than the band is tall, so a square would stop growing here.
    resizeTo(500, 600);
    const narrow = { width: previewWidth(), height: previewHeight() };

    resizeTo(880, 600);

    expect(previewWidth()).toBe(narrow.width + 380);
    // The height is the one the band pins - it must NOT follow the width.
    expect(previewHeight()).toBe(narrow.height);
  });

  it('caps each axis at the max so a huge window cannot run away with it', () => {
    render(<Harness />);
    resizeTo(MAX + 400, MAX + 400);

    expect(previewWidth()).toBe(MAX);
    expect(previewHeight()).toBe(MAX);
  });

  it('holds the minimum on a column too small to honor it', () => {
    render(<Harness />);
    // Near the 600px window-height minimum, where the preview would otherwise
    // shrink to nothing and the column would read as empty (#93).
    resizeTo(300, 100);

    expect(previewWidth()).toBe(300 - PADDING);
    expect(previewHeight()).toBe(MIN);
  });

  it('hands back the same size object when a resize changes nothing', () => {
    render(<Harness />);
    resizeTo(600, 600);
    const settled = sizes[sizes.length - 1];

    // The observer fires for every drag frame and for the OTHER axis too; a
    // fresh object each time would push new props into the MapLibre preview for
    // no change.
    resizeTo(600, 600);
    expect(sizes[sizes.length - 1]).toBe(settled);

    // Guards the guard: a real change still produces a new size.
    resizeTo(600, 500);
    expect(sizes[sizes.length - 1]).not.toBe(settled);
    expect(sizes[sizes.length - 1]?.height).toBe(500 - PADDING);
  });
});
