/**
 * Forced-interleaving coverage for the stale along-line reply guard in
 * `requestAlongLine` (useMapTools.ts:238-289) - the L0 repro-injection
 * prototype for issue #365.
 *
 * `requestAlongLine` issues `get_along_line_distance` then, once the reply
 * lands, discards it unless all three prongs still hold:
 *   1. monotonic request id (:273)
 *   2. endpoint reference identity - activeTool + measureStart/measureEnd (:274)
 *   3. project identity - created_at|modified_at|file_path (:275)
 *
 * Each test below holds the IPC promise pending with a manually-controlled
 * deferred (never a timer), mutates exactly the state one prong reads, then
 * resolves with a well-formed result and asserts the reply never lands.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { MapMouseEvent } from 'maplibre-gl';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (e: unknown, fallback?: string) =>
    (e as { message?: string })?.message ?? fallback ?? 'unknown error',
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

import { useMapTools } from '../useMapTools';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import type { Project, Station } from '../../types/project';
import type { AlongLineResult } from '../../types/ipc/AlongLineResult';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    name: 'Test Cave',
    location: null,
    created_at: '2026-01-01T00:00:00Z',
    modified_at: '2026-01-01T00:00:00Z',
    sections: [],
    station_merges: [],
    zero_datums: [],
    loop_closures: [],
    file_path: '/mock/a.stalx',
    next_section_id: 1,
    section_offsets: {},
    imported_file_hashes: [],
    imported_section_hashes: [],
    next_closure_id: 1n,
    collab: null,
    validation: {
      warn_shot_length_min: 0,
      warn_shot_length_max: 100,
      warn_depth_change_per_shot_max: 100,
      warn_azimuth_deviation_max: 45,
      azimuth_diff_threshold: 5,
      pitch_diff_threshold: 5,
      inclination_depth_diff_threshold: 5,
    },
    ...overrides,
  };
}

function makeStation(section_id: number, station_index: number, x: number, y: number): Station {
  return {
    station_ref: { section_id, station_index },
    coordinates: { x, y, z: 0 },
    is_zero_datum: false,
    gps_coordinates: null,
    merged_with: [],
    closures_with: [],
  };
}

const STATIONS: Station[] = [
  makeStation(1, 0, 0, 0),
  makeStation(1, 1, 10, 0),
  makeStation(1, 2, 20, 0),
];

/** A manually-resolved stand-in for the IPC reply: the test decides exactly
 *  when the response "lands", never a timer. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const clickEvent = { originalEvent: new MouseEvent('click') } as unknown as MapMouseEvent;

const RESULT_A: AlongLineResult = {
  along_line: 111,
  path_shots: [{ section_id: 1, shot_id: 1 }],
  path_stations: [{ section_id: 1, station_index: 1 }],
};
const RESULT_B: AlongLineResult = {
  along_line: 222,
  path_shots: [{ section_id: 1, shot_id: 2 }],
  path_stations: [{ section_id: 1, station_index: 2 }],
};

/** Flush the microtask queue enough times for the awaited invokeIpc + the
 *  guard checks that follow it to settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  invokeIpcMock.mockReset();
  useProjectStore.setState({
    project: makeProject(),
    stations: STATIONS,
    stationsAdjusted: null,
    surveyDataAdjusted: null,
  });
  useUIStore.setState({
    activeTool: 'measure',
    showStations: true,
    measureStart: null,
    measureEnd: null,
    measureDirect: null,
    measureAlongLine: null,
    measureAlongLinePending: false,
    measureSnapShot: null,
  });
});

describe('requestAlongLine stale-reply guard (#365)', () => {
  it('drops a reply that lands after the project identity changed underneath it', async () => {
    const d = deferred<AlongLineResult | null>();
    invokeIpcMock.mockReturnValueOnce(d.promise);
    const { result } = renderHook(() => useMapTools());

    act(() => {
      result.current.onStationClick?.({ section_id: 1, station_index: 0 }, clickEvent);
    });
    act(() => {
      result.current.onStationClick?.({ section_id: 1, station_index: 1 }, clickEvent);
    });
    expect(useUIStore.getState().measureAlongLinePending).toBe(true);

    // An edit/undo/project switch lands while the along-line query is in flight.
    useProjectStore.setState({ project: makeProject({ modified_at: '2026-01-02T00:00:00Z' }) });

    await act(async () => {
      d.resolve(RESULT_A);
      await flush();
    });

    expect(useUIStore.getState().measureAlongLine).toBeNull();
    expect(useUIStore.getState().measureAlongLinePending).toBe(true);
  });

  it('drops request 1 once a fast second measurement supersedes it (monotonic id)', async () => {
    const d1 = deferred<AlongLineResult | null>();
    const d2 = deferred<AlongLineResult | null>();
    invokeIpcMock.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const { result } = renderHook(() => useMapTools());

    act(() => {
      result.current.onStationClick?.({ section_id: 1, station_index: 0 }, clickEvent);
    });
    act(() => {
      result.current.onStationClick?.({ section_id: 1, station_index: 1 }, clickEvent);
    });
    expect(invokeIpcMock).toHaveBeenCalledTimes(1);

    // Clicking again on a completed measurement resets and restarts it (#26) -
    // a fast second measurement with fresh endpoints, request 1 still pending.
    act(() => {
      result.current.onStationClick?.({ section_id: 1, station_index: 2 }, clickEvent);
    });
    act(() => {
      result.current.onStationClick?.({ section_id: 1, station_index: 0 }, clickEvent);
    });
    expect(invokeIpcMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      // Resolve request 1 LAST, with a value distinct from request 2's.
      d1.resolve(RESULT_A);
      await flush();
    });
    expect(useUIStore.getState().measureAlongLine).not.toEqual({
      alongLine: RESULT_A.along_line,
      pathShots: RESULT_A.path_shots,
      pathStations: RESULT_A.path_stations,
    });

    await act(async () => {
      d2.resolve(RESULT_B);
      await flush();
    });
    expect(useUIStore.getState().measureAlongLine).toEqual({
      alongLine: RESULT_B.along_line,
      pathShots: RESULT_B.path_shots,
      pathStations: RESULT_B.path_stations,
    });
  });

  it('drops a reply once the live endpoints are no longer the ones it was issued for (reference identity)', async () => {
    const d = deferred<AlongLineResult | null>();
    invokeIpcMock.mockReturnValueOnce(d.promise);
    const { result } = renderHook(() => useMapTools());

    act(() => {
      result.current.onStationClick?.({ section_id: 1, station_index: 0 }, clickEvent);
    });
    act(() => {
      result.current.onStationClick?.({ section_id: 1, station_index: 1 }, clickEvent);
    });
    expect(useUIStore.getState().measureAlongLinePending).toBe(true);

    // Endpoints reset (e.g. a tool-switch-triggered clearMeasure) while the
    // tool itself stays 'measure' - a structurally-equal-but-fresh-object reset
    // would trip the same reference check.
    act(() => {
      useUIStore.getState().clearMeasure();
    });

    await act(async () => {
      d.resolve(RESULT_A);
      await flush();
    });

    expect(useUIStore.getState().measureAlongLine).toBeNull();
  });

  it('stores a live reply when nothing went stale (control)', async () => {
    const d = deferred<AlongLineResult | null>();
    invokeIpcMock.mockReturnValueOnce(d.promise);
    const { result } = renderHook(() => useMapTools());

    act(() => {
      result.current.onStationClick?.({ section_id: 1, station_index: 0 }, clickEvent);
    });
    act(() => {
      result.current.onStationClick?.({ section_id: 1, station_index: 1 }, clickEvent);
    });
    expect(useUIStore.getState().measureAlongLinePending).toBe(true);

    await act(async () => {
      d.resolve(RESULT_A);
      await flush();
    });

    expect(useUIStore.getState().measureAlongLine).toEqual({
      alongLine: RESULT_A.along_line,
      pathShots: RESULT_A.path_shots,
      pathStations: RESULT_A.path_stations,
    });
    expect(useUIStore.getState().measureAlongLinePending).toBe(false);
  });
});
