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

  it('treats an override on a grow column as its FLOOR, not a pin', () => {
    // Regression guard: overrides used to opt a column out of growing. Once they
    // persisted, one resize of the trailing grow column left a permanent empty
    // right gutter in every future session, with no UI to clear it.
    const cols = [col('a', { width: 100 }), col('b', { width: 100, grow: true })];
    const widths = computeColumnWidths(cols, { b: 150 }, 520, gutter);
    expect(widths[1]).toBe(400); // 520 - 20 - (100 + 150) = 250 leftover, added to 150
    expect(widths[0]! + widths[1]! + gutter).toBe(520); // no gutter left over
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
  it('starts from the host-provided widths', () => {
    const { result } = renderHook(() => useColumnWidths({ a: 200 }, undefined));
    expect(result.current.widths).toEqual({ a: 200 });
  });

  it('applyWidths updates locally WITHOUT notifying the host', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useColumnWidths({}, onChange));
    act(() => result.current.applyWidths({ a: 180 }));
    expect(result.current.widths).toEqual({ a: 180 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commitWidths notifies the host with whole integers', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useColumnWidths(undefined, onChange));
    act(() => result.current.commitWidths({ a: 180.6 }));
    expect(onChange).toHaveBeenCalledWith({ a: 181 });
    expect(result.current.widths).toEqual({ a: 181 });
  });

  it('commitWidths clamps out-of-range and non-finite widths', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useColumnWidths(undefined, onChange));
    act(() => result.current.commitWidths({ tiny: 1, huge: 99999, bad: Number.NaN }));
    expect(onChange).toHaveBeenCalledWith({
      tiny: MIN_COL_WIDTH,
      huge: MAX_COL_WIDTH,
      bad: MIN_COL_WIDTH,
    });
  });

  it('revertWidths drops an uncommitted change', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useColumnWidths({ a: 100 }, onChange));
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
    const { result } = renderHook(() => useColumnWidths(undefined, onChange));
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
      ({ widths }: { widths: ColumnWidths }) => useColumnWidths(widths, onChange),
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
      ({ widths }: { widths: ColumnWidths }) => useColumnWidths(widths, undefined),
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
      ({ widths }: { widths: ColumnWidths }) => useColumnWidths(widths, onChange),
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
});
