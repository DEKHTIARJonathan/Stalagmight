/**
 * #576 D39(g): the distance-gradient origin follows its physical station across
 * survey edits.
 *
 * The origin is a positional `StationRef`, and until now only a section reverse
 * re-pointed it (a mirror in `applyReverseAftermath`). An insert or a delete
 * before it renumbers the section just as silently: the ramp, the legend, the
 * origin ring and the DetailPanel badge quietly re-rooted on the neighbouring
 * station. Decided ("Follow the station"): the mutation seams that already carry
 * the gas-plan pins across an edit with backend anchors (#310) carry the origin
 * too - an anchor taken before the edit, re-resolved after it. A station that no
 * longer exists falls back to the entrance with a notice; the reverse-only mirror
 * is gone, since an anchor already survives a reverse (applying both would move
 * the origin twice).
 *
 * Store tier: the real projectStore seams with the IPC mocked; the anchor IPC is
 * scripted here, so what is pinned is the seam's use of it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '../projectStore';
import { useGasPlanStore } from '../gasPlanStore';
import { useUIStore } from '../uiStore';
import { TOAST_KEYS } from '../../utils/toastKeys';
import type { StationRef } from '../../types/project';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({ invokeIpc: invokeIpcMock }));

const SECTION = 1;
const ref = (station_index: number): StationRef => ({ section_id: SECTION, station_index });

function project() {
  return {
    name: 'Origin',
    location: null,
    created_at: '2026-01-01T00:00:00Z',
    modified_at: '2026-01-01T00:00:01Z',
    sections: [
      {
        id: SECTION,
        name: 'CaveA',
        surveyor: null,
        date: null,
        color: '#fff',
        direction: 'in',
        quality: 1,
        shots: [0, 1, 2, 3, 4, 5, 6].map((id) => ({ id, azimuth_in: 0, azimuth_out: 0 })),
        next_shot_id: 7,
      },
    ],
    station_merges: [],
    zero_datums: [],
    loop_closures: [],
    file_path: '/tmp/origin.stalx',
    next_section_id: 2,
    section_offsets: {},
    imported_file_hashes: [],
    imported_section_hashes: [],
  };
}

/**
 * Serve the refresh IPCs and a successful mutation; `resolveTo` is what the anchor of the
 * origin re-resolves to after the edit (null: its station is gone). Every anchor call is
 * recorded, with the ref it was asked about.
 */
function serve(resolveTo: StationRef | null, reversed?: { section_id: number; shot_count: number }[]) {
  const anchorCalls: string[] = [];
  invokeIpcMock.mockImplementation(async (command: string, args?: { refs?: StationRef[] }) => {
    switch (command) {
      case 'plan_anchors_for_refs':
        anchorCalls.push(command);
        return (args?.refs ?? []).map((r) => ({ anchorOf: r }));
      case 'plan_refs_for_anchors':
        anchorCalls.push(command);
        return [resolveTo];
      case 'get_project_state':
        return { project: project(), stations: [], stats: null, frozen_shots: [] };
      case 'can_undo':
      case 'can_redo':
        return false;
      case 'get_project_warnings':
        return [];
      case 'check_project_integrity':
        return { messages: [], save_blocked: false };
      default:
        return {
          success: true,
          warnings: [],
          error: null,
          section_ids: [],
          ...(reversed ? { reversed_sections: reversed } : {}),
        };
    }
  });
  return anchorCalls;
}

const SHOT = {
  azimuth_in: 0, azimuth_out: 0, length: 5, depth_in: 0, depth_out: 0, pitch_in: null, pitch_out: null,
  left: null, right: null, up: null, down: null, comment: null, kind: 'Normal' as const,
  marker_index: null, temperature: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useGasPlanStore.getState().reset();
  useUIStore.setState({ distanceGradientOrigin: null, toasts: [] });
  useProjectStore.setState({ project: project() as never });
});

describe('the distance-gradient origin follows its station (D39(g))', () => {
  it('moves with its station when a shot is inserted before it', async () => {
    useUIStore.getState().setDistanceGradientOrigin(ref(5));
    serve(ref(6));
    await useProjectStore.getState().createShot(SECTION, SHOT, undefined, 0);
    expect(useUIStore.getState().distanceGradientOrigin, 'origin after an insert before it').toEqual(ref(6));
  });

  it('follows it back on undo', async () => {
    useUIStore.getState().setDistanceGradientOrigin(ref(6));
    serve(ref(5));
    await useProjectStore.getState().undo();
    expect(useUIStore.getState().distanceGradientOrigin).toEqual(ref(5));
  });

  it('falls back to the entrance with a notice when its station is deleted', async () => {
    useUIStore.getState().setDistanceGradientOrigin(ref(5));
    serve(null);
    await useProjectStore.getState().deleteShot(SECTION, 4);
    expect(useUIStore.getState().distanceGradientOrigin).toBeNull();
    const toasts = useUIStore.getState().toasts;
    expect(toasts.map((t) => [t.key, t.kind])).toEqual([[TOAST_KEYS.DISTANCE_ORIGIN_RESET, 'info']]);
  });

  it('is not mirrored a second time on a reverse: the anchor already followed it', async () => {
    // The backend reports the reverse; the anchor re-resolves to the mirrored station. A
    // leftover mirror would move it on to 7 - 2 = 5.
    useUIStore.getState().setDistanceGradientOrigin(ref(5));
    serve(ref(2), [{ section_id: SECTION, shot_count: 7 }]);
    await useProjectStore.getState().reverseSection(SECTION, false);
    expect(useUIStore.getState().distanceGradientOrigin).toEqual(ref(2));
  });

  it('leaves an origin re-picked during the round trip alone', async () => {
    useUIStore.getState().setDistanceGradientOrigin(ref(5));
    serve(ref(6));
    invokeIpcMock.mockImplementationOnce(async (command: string, args?: { refs?: StationRef[] }) => {
      // The capture: the user picks another origin while it is on the wire.
      useUIStore.getState().setDistanceGradientOrigin(ref(1));
      return (args?.refs ?? []).map((r) => ({ anchorOf: r, command }));
    });
    await useProjectStore.getState().createShot(SECTION, SHOT, undefined, 0);
    expect(useUIStore.getState().distanceGradientOrigin).toEqual(ref(1));
  });

  it('costs no anchor round trip while the origin is the entrance', async () => {
    const anchorCalls = serve(ref(6));
    await useProjectStore.getState().createShot(SECTION, SHOT, undefined, 0);
    expect(anchorCalls).toEqual([]);
    expect(useUIStore.getState().distanceGradientOrigin).toBeNull();
  });
});
