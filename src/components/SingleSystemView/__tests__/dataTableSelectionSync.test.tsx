/**
 * D21 (#576): an external selection (map, sections panel) always moves the data
 * table's cursor, however soon it follows a keyboard move in the table.
 *
 * The table handed the grid a level-triggered `selectedRow` derived from a
 * scroll-key state that two 100 ms timers reset to null. The grid reacted only
 * when that prop CHANGED, so re-selecting a shot on the map within 100 ms of
 * the first selection - after the user had moved the cursor off it with the
 * keyboard - set the same key again: React bailed out of the same-value
 * update, the prop never changed, and the table stayed on the wrong row while
 * the map and detail panel showed the selected shot. Each external selection
 * is now a request with its own nonce, which the grid honours once.
 *
 * Fake timers hold the old 100 ms timers shut, which is the race window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 33, size: 33 })),
    getTotalSize: () => count * 33,
    scrollToIndex: vi.fn(),
  }),
}));

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/ipc', () => ({ invokeIpc: invokeIpcMock }));

import DataTable from '../DataTable';
import { useProjectStore } from '../../../store/projectStore';
import { useUIStore } from '../../../store/uiStore';
import { useSpeleoStore } from '../../../store/speleoStore';
import { defaultConfig } from '../../../types/config';
import type { Config } from '../../../types/config';
import type { Section, Shot, Station } from '../../../types/project';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const shot = (id: number): Shot => ({
  id,
  azimuth_in: 10,
  azimuth_out: 10,
  length: id * 10,
  depth_in: 0,
  depth_out: 1,
  pitch_in: null,
  pitch_out: null,
  left: null,
  right: null,
  up: null,
  down: null,
  comment: null,
  kind: 'Normal',
  marker_index: null,
  temperature: null,
});

const section: Section = {
  id: 1,
  name: 'CaveA',
  surveyor: null,
  date: null,
  color: '#3388ff',
  direction: 'in',
  quality: 0,
  shots: [shot(1), shot(2), shot(3)],
  next_shot_id: 4,
  reverse_parity: false,
  gauge_shot_uuid: null,
  gauge_neighbour_uuid: null,
};

const station = (index: number): Station => ({
  station_ref: { section_id: 1, station_index: index },
  coordinates: { x: index, y: 0, z: 0 },
  is_zero_datum: false,
  gps_coordinates: null,
  merged_with: [],
});

/** The grid row holding the cursor, as its row index (-1 when none). */
const activeRow = () => {
  const row = document.querySelector('[role="row"][data-active="true"]');
  return row ? Number(row.getAttribute('data-testid')?.replace('grid-row-', '')) : -1;
};

const scroller = () => document.querySelector('[data-grid-id="grid"] > div[tabindex="0"]')!;

function selectExternally(selection: Parameters<ReturnType<typeof useUIStore.getState>['setSelection']>[0]) {
  act(() => useUIStore.getState().setSelection(selection));
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.useFakeTimers();
  invokeIpcMock.mockReset();
  invokeIpcMock.mockImplementation((command: string) =>
    Promise.resolve(command === 'get_config' ? structuredClone(defaultConfig) : undefined)
  );
  useProjectStore.setState({
    config: structuredClone(defaultConfig) as Config,
    stations: [station(0), station(1), station(2), station(3)],
  });
  useUIStore.setState({ toasts: [], selection: null });
  useSpeleoStore.setState({ projectLinkKind: 'local', link: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('DataTable selection sync with the map (D21)', () => {
  it('moves the cursor back to a shot re-selected right after a keyboard move', () => {
    render(<DataTable sections={[section]} />);

    selectExternally({ type: 'shot', sectionId: 1, shotId: 2 });
    expect(activeRow()).toBe(1);

    // Keyboard move inside the table: cursor and store selection on shot 3.
    act(() => {
      fireEvent.keyDown(scroller(), { key: 'ArrowDown' });
    });
    expect(activeRow()).toBe(2);
    expect(useUIStore.getState().selection).toMatchObject({ type: 'shot', shotId: 3 });

    // The map selects shot 2 again, well inside 100 ms of the first selection.
    selectExternally({ type: 'shot', sectionId: 1, shotId: 2 });
    expect(activeRow()).toBe(1);

    // Still true once any timer has had its chance to run.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(activeRow()).toBe(1);
  });

  it('does the same in the stations view', () => {
    render(<DataTable sections={[section]} />);

    selectExternally({ type: 'station', stationRef: { section_id: 1, station_index: 1 } });
    expect(screen.getByTestId('data-table-view-stations')).toBeTruthy();
    expect(activeRow()).toBe(1);

    act(() => {
      fireEvent.keyDown(scroller(), { key: 'ArrowDown' });
    });
    expect(activeRow()).toBe(2);

    selectExternally({ type: 'station', stationRef: { section_id: 1, station_index: 1 } });
    expect(activeRow()).toBe(1);
  });

  it('a later row shift does not pull the cursor back to an old external selection', () => {
    const { rerender } = render(<DataTable sections={[section]} />);

    selectExternally({ type: 'shot', sectionId: 1, shotId: 3 });
    expect(activeRow()).toBe(2);
    act(() => {
      fireEvent.keyDown(scroller(), { key: 'ArrowUp' });
    });
    expect(activeRow()).toBe(1);

    // A shot appears above the old selection (e.g. an undo restoring one),
    // still inside the old 100 ms window: shot 3 moves from row 2 to row 3.
    rerender(<DataTable sections={[{ ...section, shots: [shot(9), ...section.shots] }]} />);
    expect(activeRow()).toBe(1);
  });
});
