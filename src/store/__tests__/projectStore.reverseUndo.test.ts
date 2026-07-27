/**
 * Undo/redo of a section reverse must move the frontend's positional refs back
 * with it (#24).
 *
 * The hazard: a reverse renumbers station `i` to `N - i`, and the gas-plan pins
 * plus the distance-gradient origin are plain `StationRef`s. Undo restores the
 * old numbering but leaves those refs where the forward mirror put them - still
 * IN RANGE, now naming the opposite physical station, and (for the plan) written
 * straight into the saved dive plan. No error is ever raised.
 *
 * `executeUndoRedo` therefore snapshots the watched sections' station positions
 * around the IPC and re-mirrors whatever flipped. These tests drive the real
 * store action with the IPC mocked, so deleting that wiring fails here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '../projectStore';
import { useGasPlanStore } from '../gasPlanStore';
import { useUIStore } from '../uiStore';
import type { Station } from '../../types/project';

const invokeIpcMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
}));

const SECTION = 4;

/** A 3-shot (4-station) section laid out along +x, in station order. */
function line(xs: number[]): Station[] {
  return xs.map((x, i) => ({
    station_ref: { section_id: SECTION, station_index: i },
    coordinates: { x, y: 0, z: 0 },
    is_zero_datum: false,
    gps_coordinates: null,
    merged_with: [],
    closures_with: [],
  }));
}

const FORWARD = [0, 10, 25, 40];
/** The same four places, numbered from the other end - i.e. after a reverse. */
const REVERSED = [40, 25, 10, 0];

function projectWith(stations: Station[]) {
  return {
    name: 'Reverse',
    location: null,
    created_at: '2026-01-01T00:00:00Z',
    modified_at: '2026-01-01T00:00:01Z',
    sections: [
      {
        id: SECTION,
        name: 'Main',
        surveyor: null,
        date: null,
        color: '#fff',
        direction: 'in',
        quality: 1,
        shots: stations.slice(1).map((_s, i) => ({ id: i, azimuth_in: 0, azimuth_out: 0 })),
        next_shot_id: stations.length,
      },
    ],
    station_merges: [],
    zero_datums: [],
    loop_closures: [],
    file_path: '/tmp/reverse.stalx',
    next_section_id: 5,
    section_offsets: {},
    imported_file_hashes: [],
    imported_section_hashes: [],
  };
}

/** Point every read-only refresh IPC at a project whose stations are `stations`. */
function serveState(stations: Station[]) {
  invokeIpcMock.mockImplementation(async (command: string) => {
    switch (command) {
      case 'undo':
      case 'redo':
      case 'undo_to':
        return { success: true, warnings: [], error: null, section_ids: [] };
      case 'get_project_state':
        return {
          project: projectWith(stations),
          stations,
          stats: null,
          frozen_shots: [],
        };
      case 'can_undo':
      case 'can_redo':
        return false;
      case 'get_project_warnings':
        return [];
      case 'check_project_integrity':
        return { messages: [], save_blocked: false };
      default:
        return undefined;
    }
  });
}

const ref = (station_index: number) => ({ section_id: SECTION, station_index });

describe('projectStore undo/redo re-mirrors positional refs (#24)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGasPlanStore.getState().reset();
    useUIStore.setState({ distanceGradientOrigin: null, selection: null, multiSelection: [] });
    // Pre-undo state: the section is currently REVERSED and every pin was
    // already mirrored onto it by the Reverse dialog.
    useProjectStore.setState({ stations: line(REVERSED), project: null });
  });

  it('mirrors the plan pins back when an undo flips the numbering', async () => {
    const gas = useGasPlanStore.getState();
    gas.setOrigin(ref(3));
    gas.setEndpoint(ref(2));
    gas.addWaypoint(ref(1));
    gas.addMarkedPoint(ref(0));
    gas.setStageDropOverride(0, ref(2));

    serveState(line(FORWARD));
    await useProjectStore.getState().undo();

    const after = useGasPlanStore.getState();
    expect(after.origin).toEqual(ref(0));
    expect(after.endpoint).toEqual(ref(1));
    expect(after.waypoints).toEqual([ref(2)]);
    expect(after.markedPoints[0]?.station).toEqual(ref(3));
    expect(after.stageDropOverrides[0]).toEqual(ref(1));
  });

  it('mirrors the distance-gradient origin and clears armed tool state', async () => {
    useUIStore.setState({ distanceGradientOrigin: ref(3) });
    useUIStore.getState().setSelection({ type: 'station', stationRef: ref(3) });
    // Watched only because a positional ref points into the section: with the
    // plan empty, the distance origin has to be enough on its own.
    serveState(line(FORWARD));
    await useProjectStore.getState().undo();

    expect(useUIStore.getState().distanceGradientOrigin).toEqual(ref(0));
    expect(useUIStore.getState().selection).toBeNull();
  });

  it('re-mirrors on redo too, and on a multi-step undo_to', async () => {
    useGasPlanStore.getState().setOrigin(ref(3));

    serveState(line(FORWARD));
    await useProjectStore.getState().redo();
    expect(useGasPlanStore.getState().origin).toEqual(ref(0));

    // And back again through the history dropdown's multi-step path.
    useProjectStore.setState({ stations: line(FORWARD) });
    serveState(line(REVERSED));
    await useProjectStore.getState().undoTo(2);
    expect(useGasPlanStore.getState().origin).toEqual(ref(3));
  });

  it('leaves the pins alone on an undo that did not renumber anything', async () => {
    useGasPlanStore.getState().setOrigin(ref(3));

    // Same numbering before and after: an ordinary undo must not churn the plan.
    serveState(line(REVERSED));
    await useProjectStore.getState().undo();

    expect(useGasPlanStore.getState().origin).toEqual(ref(3));
    expect(useUIStore.getState().selection).toBeNull();
  });
});
