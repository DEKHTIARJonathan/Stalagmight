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
 * `executeUndoRedo` therefore re-mirrors the sections the backend reports on the
 * result as renumbered (`CommandResult.reversed_sections`, populated for a
 * forward reverse and for the undo/redo that re-reverses it). These tests drive
 * the real store action with the IPC mocked, so deleting that wiring fails here.
 *
 * From `undo_to`/`redo_to` the field is an ORDERED PER-STEP LOG - one entry per
 * reversing step, repeats intact, each carrying the shot count in force at ITS
 * step - so the store composes the entries into one transform per section and
 * applies it once. The Playwright IPC mock stubs undo/redo as no-ops that never
 * emit the field, so this path is only reachable at the store level, here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '../projectStore';
import { useGasPlanStore } from '../gasPlanStore';
import { useUIStore } from '../uiStore';
import type { ReversedSection } from '../../types/ipc/ReversedSection';
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
/** Reversed AND translated, as one batch that reverses and moves produces. */
const REVERSED_AND_MOVED = REVERSED.map((x) => x + 1000);

/** One `reversed_sections` entry: the section, and the count in force at that step. */
const reversed = (shot_count: number): ReversedSection => ({
  section_id: SECTION,
  shot_count,
});

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

/**
 * Point every read-only refresh IPC at a project whose stations are `stations`,
 * and have undo/redo report `reversedSections` as renumbered. Omit it for an
 * operation that reversed nothing: the field is then absent from the wire, which
 * is what the backend does for every other command. `error` turns the undo into
 * a FAILED one that still reports what it managed to apply.
 */
function serveState(
  stations: Station[],
  reversedSections?: ReversedSection[],
  error?: string
) {
  invokeIpcMock.mockImplementation(async (command: string) => {
    switch (command) {
      case 'undo':
      case 'redo':
      case 'undo_to':
        return {
          success: error === undefined,
          warnings: [],
          error: error ?? null,
          section_ids: [],
          ...(reversedSections === undefined
            ? {}
            : { reversed_sections: reversedSections }),
        };
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

    serveState(line(FORWARD), [reversed(3)]);
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
    // With the plan empty, the distance origin has to be enough on its own.
    serveState(line(FORWARD), [reversed(3)]);
    await useProjectStore.getState().undo();

    expect(useUIStore.getState().distanceGradientOrigin).toEqual(ref(0));
    expect(useUIStore.getState().selection).toBeNull();
  });

  it('re-mirrors on redo too, and on a multi-step undo_to', async () => {
    useGasPlanStore.getState().setOrigin(ref(3));

    serveState(line(FORWARD), [reversed(3)]);
    await useProjectStore.getState().redo();
    expect(useGasPlanStore.getState().origin).toEqual(ref(0));

    // And back again through the history dropdown's multi-step path, which
    // reports one entry per reversing step it walked past.
    useProjectStore.setState({ stations: line(FORWARD) });
    serveState(line(REVERSED), [reversed(3)]);
    await useProjectStore.getState().undoTo(2);
    expect(useGasPlanStore.getState().origin).toEqual(ref(3));
  });

  it('leaves the pins alone on an undo that did not renumber anything', async () => {
    useGasPlanStore.getState().setOrigin(ref(3));

    // No `reversed_sections` on the wire: an ordinary undo must not churn the
    // plan.
    serveState(line(REVERSED));
    await useProjectStore.getState().undo();

    expect(useGasPlanStore.getState().origin).toEqual(ref(3));
    expect(useUIStore.getState().selection).toBeNull();
  });

  it('mirrors a section that was reversed AND moved in the same operation', async () => {
    // The case that defeats any position-diffing inference: undoing a batch that
    // both reversed and moved the section leaves its stations matching NEITHER
    // the old numbering nor its mirror, so the geometry reports nothing while
    // the numbering really did flip. The backend says so outright instead.
    useGasPlanStore.getState().setOrigin(ref(3));
    useUIStore.setState({ distanceGradientOrigin: ref(1) });

    serveState(line(REVERSED_AND_MOVED), [reversed(3)]);
    await useProjectStore.getState().undo();

    expect(useGasPlanStore.getState().origin).toEqual(ref(0));
    expect(useUIStore.getState().distanceGradientOrigin).toEqual(ref(2));
  });

  it('treats an equal-count double reverse as a TOTAL no-op', async () => {
    // Two reverses of one section at the same count, undone as one range: the
    // composed transform is exactly `i -> i`, so nothing may move and nothing may
    // be cleared. The out-of-range origin is the discriminator - it is what a
    // per-entry replay would drag onto an end station (`9 -> 0 -> 7`), because
    // each replayed mirror clamps, and it is what the identity map would clamp to
    // `maxIndex` if `applyReverseAftermath` ran at all.
    useGasPlanStore.getState().setOrigin(ref(9));
    useUIStore.getState().setSelection({ type: 'station', stationRef: ref(2) });

    serveState(line(REVERSED), [reversed(7), reversed(7)]);
    await useProjectStore.getState().undoTo(1);

    expect(useGasPlanStore.getState().origin).toEqual(ref(9));
    // The four UI clears are gated on the same "did anything actually renumber"
    // question, and a cancelled-out range did not: the user's selection and
    // half-staged merge are still valid.
    expect(useUIStore.getState().selection).not.toBeNull();
  });

  it('composes two reverses at DIFFERENT counts instead of cancelling them', async () => {
    // `[Reverse, CreateShot, Reverse]` walked back by one `undo_to`: the steps
    // mirrored against 4 shots then 3, so the net map is `i -> 3 - (4 - i)`, i.e.
    // one station down. Cancelling the repeat (parity) would leave the pin at 3;
    // dividing by the post-range count alone would send it to 0.
    useGasPlanStore.getState().setOrigin(ref(3));

    serveState(line(FORWARD), [reversed(4), reversed(3)]);
    await useProjectStore.getState().undoTo(2);

    expect(useGasPlanStore.getState().origin).toEqual(ref(2));
  });

  it('mirrors what a PARTIALLY failed undo_to already applied', async () => {
    // The earlier steps flipped their sections and cannot be rolled back, so the
    // backend attaches them to the failure return. Ignoring the field on
    // `success === false` leaves the pins on the opposite physical stations with
    // only a step-N-of-M toast to explain it.
    useGasPlanStore.getState().setOrigin(ref(3));
    useUIStore.setState({ distanceGradientOrigin: ref(1) });

    serveState(line(FORWARD), [reversed(3)], 'Undo failed at step 2 of 3: boom');
    const result = await useProjectStore.getState().undoTo(2);

    expect(result.success).toBe(false);
    expect(useGasPlanStore.getState().origin).toEqual(ref(0));
    expect(useUIStore.getState().distanceGradientOrigin).toEqual(ref(2));
  });

  it('ignores the field on a failure that mutated nothing', async () => {
    // Step 1 of N failing means no step landed, so there is nothing to mirror -
    // and `executeUndoRedo` only reads the field for the partial case.
    useGasPlanStore.getState().setOrigin(ref(3));

    serveState(line(REVERSED), [reversed(3)], 'Undo failed at step 1 of 3: boom');
    await useProjectStore.getState().undoTo(2);

    expect(useGasPlanStore.getState().origin).toEqual(ref(3));
  });
});
