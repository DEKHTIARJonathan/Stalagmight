import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useColumnWidths,
  computeColumnWidths,
  MIN_COL_WIDTH,
  MAX_COL_WIDTH,
  type ColumnWidths,
} from '../useColumnWidths';
import type { GridColumn } from '../types';

// `.tsx` so this runs in the jsdom tier (renderHook needs a DOM).

interface Row {
  a: string;
}

const col = (key: string, extra: Partial<GridColumn<Row>> = {}): GridColumn<Row> => ({
  key,
  header: key,
  getValue: (r) => r.a,
  ...extra,
});

describe('computeColumnWidths', () => {
  const gutter = 20;

  it('uses each column width, falling back to the declared default', () => {
    const cols = [col('a', { width: 100 }), col('b')];
    // 120 is DEFAULT_COL_WIDTH.
    expect(computeColumnWidths(cols, {}, 0, gutter)).toEqual([100, 120]);
  });

  it('lets an override replace the declared width', () => {
    const cols = [col('a', { width: 100 }), col('b', { width: 100 })];
    expect(computeColumnWidths(cols, { a: 250 }, 0, gutter)).toEqual([250, 100]);
  });

  it('gives leftover space to the grow column so the grid fills its container', () => {
    const cols = [col('a', { width: 100 }), col('b', { width: 100, grow: true })];
    // 520 avail - 20 gutter - 200 base = 300 leftover, all to `b`.
    expect(computeColumnWidths(cols, {}, 520, gutter)).toEqual([100, 400]);
  });

  it('PINS a resized grow column instead of re-growing it', () => {
    // This started life asserting the opposite - that an override was only the grow
    // FLOOR. That rule made a narrowing drag a no-op: the width the drag removed came
    // back to the same column as leftover, so the handle was dead at every distance
    // while a phantom width was still persisted.
    const cols = [col('a', { width: 100 }), col('b', { width: 100, grow: true })];
    const widths = computeColumnWidths(cols, { b: 150 }, 520, gutter);
    expect(widths).toEqual([100, 150]);
    // The grid is now narrower than its container, which is the accepted trade.
    expect(widths[0]! + widths[1]! + gutter).toBeLessThan(520);
  });

  it('honours a narrowing drag on a grow column at every distance', () => {
    // The drag starts from the RENDERED width, so this walks the exact sequence a
    // leftward drag produces. Under the old floor rule every step returned 400.
    const cols = [col('a', { width: 100 }), col('b', { width: 100, grow: true })];
    const grown = computeColumnWidths(cols, {}, 520, gutter)[1]!;
    expect(grown).toBe(400);
    for (const dx of [-1, -50, -200, -300]) {
      expect(computeColumnWidths(cols, { b: grown + dx }, 520, gutter)[1]).toBe(grown + dx);
    }
  });

  it('does not shrink a pinned grow width to fit the container', () => {
    // This asserted the OPPOSITE until the review caught it. Capping the RENDERED
    // width while commitWidths persists the RAW dragged value is how a widening
    // drag went dead at the panel edge and still wrote a width the user never saw.
    // Rendered must equal what gets persisted, even when that overflows.
    const cols = [col('a', { width: 100 }), col('b', { width: 100, grow: true })];
    const wide = computeColumnWidths(cols, {}, 2020, gutter)[1]!;
    expect(wide).toBe(1900);
    const narrow = computeColumnWidths(cols, { b: wide }, 520, gutter);
    expect(narrow).toEqual([100, 1900]);
    // Overflow is the point: the grid scrolls rather than lying about the width.
    expect(narrow[0]! + narrow[1]! + gutter).toBeGreaterThan(520);
  });

  it('tracks the pointer for every widening distance on a grow column', () => {
    // The regression the cap introduced: each of these used to collapse to the
    // same rendered width, so the handle stopped following the pointer.
    const cols = [col('a', { width: 100 }), col('b', { width: 100, grow: true })];
    const seen = new Set<number>();
    for (const w of [500, 900, 1400, 1900]) {
      seen.add(computeColumnWidths(cols, { b: w }, 520, gutter)[1]!);
    }
    expect(seen).toEqual(new Set([500, 900, 1400, 1900]));
  });

  it('does not re-grow a deliberately narrow pin when the container is wide', () => {
    const cols = [col('a', { width: 100 }), col('b', { width: 100, grow: true })];
    expect(computeColumnWidths(cols, { b: 150 }, 2020, gutter)).toEqual([100, 150]);
  });

  it('keeps growing the grow columns that were NOT resized', () => {
    const cols = [
      col('a', { width: 10, grow: true }),
      col('b', { width: 10, grow: true }),
      col('c', { width: 10 }),
    ];
    // `a` is pinned at 30; 200 avail - 0 gutter - (30 + 10 + 10) = 150 to `b` alone.
    expect(computeColumnWidths(cols, { a: 30 }, 200, 0)).toEqual([30, 160, 10]);
  });

  it('splits leftover space across several grow columns, remainder first', () => {
    const cols = [col('a', { width: 10, grow: true }), col('b', { width: 10, grow: true })];
    // 45 avail - 0 gutter - 20 base = 25 leftover -> 12 each, 1 remainder to the first.
    expect(computeColumnWidths(cols, {}, 45, 0)).toEqual([23, 22]);
  });

  it('does not shrink a column when the container is too narrow', () => {
    const cols = [col('a', { width: 100 }), col('b', { width: 100, grow: true })];
    expect(computeColumnWidths(cols, {}, 50, gutter)).toEqual([100, 100]);
  });
});

describe('useColumnWidths', () => {
  /** Every column key these tests use, i.e. "nothing here is an orphan". The
   *  pruning behaviour itself is covered by its own test below. */
  const ALL_KEYS = ['a', 'b', 'tiny', 'huge', 'bad'];

  it('starts from the host-provided widths', () => {
    const { result } = renderHook(() => useColumnWidths({ a: 200 }, undefined, ALL_KEYS));
    expect(result.current.widths).toEqual({ a: 200 });
  });

  it('applyWidths updates locally WITHOUT notifying the host', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useColumnWidths({}, onChange, ALL_KEYS));
    act(() => result.current.applyWidths({ a: 180 }));
    expect(result.current.widths).toEqual({ a: 180 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commitWidths notifies the host with whole integers', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useColumnWidths(undefined, onChange, ALL_KEYS));
    act(() => result.current.commitWidths({ a: 180.6 }));
    expect(onChange).toHaveBeenCalledWith({ a: 181 });
    expect(result.current.widths).toEqual({ a: 181 });
  });

  it('commitWidths does not notify the host when nothing actually changed', () => {
    // A bare mousedown/mouseup on a resize handle sets the drag flag without moving
    // anything, and the release path still commits. That used to spread the whole
    // width map outward - a host render, and for a persisting host a config write -
    // for a stray click. Also covers a drag returned to where it started.
    const onChange = vi.fn();
    const { result } = renderHook(() => useColumnWidths({ a: 200 }, onChange, ALL_KEYS));
    act(() => result.current.commitWidths({ a: 200 }));
    expect(onChange).not.toHaveBeenCalled();
    // A real change still gets through, so this is not just a dead commit path.
    act(() => result.current.commitWidths({ a: 260 }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ a: 260 });
  });

  it('commitWidths clamps out-of-range and non-finite widths', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useColumnWidths(undefined, onChange, ALL_KEYS));
    act(() => result.current.commitWidths({ tiny: 1, huge: 99999, bad: Number.NaN }));
    expect(onChange).toHaveBeenCalledWith({
      tiny: MIN_COL_WIDTH,
      huge: MAX_COL_WIDTH,
      bad: MIN_COL_WIDTH,
    });
  });

  it('revertWidths drops an uncommitted change', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useColumnWidths({ a: 100 }, onChange, ALL_KEYS));
    act(() => result.current.applyWidths({ a: 900 }));
    expect(result.current.widths).toEqual({ a: 900 });

    act(() => result.current.revertWidths());

    expect(result.current.widths).toEqual({ a: 100 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('revertWidths falls back to the last COMMITTED map, not the original', () => {
    // The abandoned-drag path: a resize lands on `a`, then a second drag on `b` is
    // abandoned. Reverting must keep `a`'s committed width and drop only `b`.
    const onChange = vi.fn();
    const { result } = renderHook(() => useColumnWidths(undefined, onChange, ALL_KEYS));
    act(() => result.current.commitWidths({ a: 200 }));
    act(() => result.current.applyWidths({ a: 200, b: 900 }));

    act(() => result.current.revertWidths());

    expect(result.current.widths).toEqual({ a: 200 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('follows the host prop when the host does not accept a commit', () => {
    // The controlled contract, pinned because the failure mode is confusing: if a
    // host passes `columnWidths` but does not update it from onColumnWidthsChange,
    // the prop stays authoritative and the commit is reverted on the next render.
    // (Hosts that want the grid to own widths pass no prop at all.)
    const onChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ widths }: { widths: ColumnWidths }) => useColumnWidths(widths, onChange, ALL_KEYS),
      { initialProps: { widths: { a: 100 } } },
    );
    act(() => result.current.commitWidths({ a: 300 }));
    expect(onChange).toHaveBeenCalledWith({ a: 300 });

    // Host ignored it and re-renders with its own value, fresh identity.
    rerender({ widths: { a: 100 } });

    expect(result.current.widths).toEqual({ a: 100 });
  });

  it('adopts a genuine host change, e.g. config arriving after mount', () => {
    const { result, rerender } = renderHook(
      ({ widths }: { widths: ColumnWidths }) => useColumnWidths(widths, undefined, ALL_KEYS),
      { initialProps: { widths: {} } },
    );
    rerender({ widths: { a: 300 } });
    expect(result.current.widths).toEqual({ a: 300 });
  });

  it('ignores the host echoing back a width this hook just committed', () => {
    // The host persists and re-reads config, handing the same values back as a new
    // object identity. Adopting that echo would fight a resize already in progress.
    const onChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ widths }: { widths: ColumnWidths }) => useColumnWidths(widths, onChange, ALL_KEYS),
      { initialProps: { widths: {} } },
    );
    act(() => result.current.commitWidths({ a: 200 }));
    // Same content, fresh identity - the echo.
    rerender({ widths: { a: 200 } });
    act(() => result.current.applyWidths({ a: 200, b: 400 }));
    // A re-render with the echo again must not wipe the in-progress `b`.
    rerender({ widths: { a: 200 } });
    expect(result.current.widths).toEqual({ a: 200, b: 400 });
  });

  it('commitWidths drops widths for columns this grid no longer declares', () => {
    // #357 item 6: the map is spread whole on every commit and persisted whole, so
    // a key that stopped naming a real column was re-persisted forever and
    // config.toml grew monotonically. The host arrives holding a stale key here.
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useColumnWidths({ a: 120, gone: 300 }, onChange, ['a', 'b']),
    );
    act(() => result.current.commitWidths({ a: 160, gone: 300 }));
    // What the host is TOLD to persist is the whole assertion. The rendered map is
    // not: this host is controlled and keeps handing its own prop back, so the
    // "follows the host prop when the host does not accept a commit" contract
    // above re-adopts `{ a: 120, gone: 300 }` on the next render.
    expect(onChange).toHaveBeenCalledWith({ a: 160 });
  });

  it('commitWidths KEEPS the width of a declared-but-hidden column', () => {
    // Documents the contract from the hook's side: a key inside `declaredKeys`
    // survives a commit whether or not the grid is currently showing it.
    //
    // It CANNOT pin the real property, and is kept only as documentation. The
    // hook has no notion of "hidden" - it just trusts `declaredKeys` - so this
    // passes with the orphan prune removed outright, and the choice it is
    // really about (SpreadsheetGrid passing `orderedKeys` rather than the
    // visible keys) is invisible at this tier. That choice is pinned by
    // __tests__/spreadsheetGridColumnWidths.test.tsx, which renders the grid.
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useColumnWidths({ a: 120, hiddenCol: 250 }, onChange, ['a', 'hiddenCol']),
    );
    act(() => result.current.commitWidths({ a: 160, hiddenCol: 250 }));
    expect(onChange).toHaveBeenCalledWith({ a: 160, hiddenCol: 250 });
  });

  it('a prune alone is a real change, even with every surviving width unchanged', () => {
    // The no-op guard compares against the last SETTLED map, so a commit whose only
    // effect is dropping an orphan must still reach the host - otherwise the stale
    // key is never actually removed from config.toml.
    const onChange = vi.fn();
    const { result } = renderHook(() => useColumnWidths({ a: 120, gone: 300 }, onChange, ['a']));
    act(() => result.current.commitWidths({ a: 120, gone: 300 }));
    expect(onChange).toHaveBeenCalledWith({ a: 120 });
  });
});
