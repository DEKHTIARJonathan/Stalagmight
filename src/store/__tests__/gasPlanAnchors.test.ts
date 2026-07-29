/**
 * Anchor-backed live plan pins (#310).
 *
 * The hazard: a gas-plan pin is a positional `StationRef { section_id, station_index }`, and a
 * survey edit made in Survey mode - a delete, an insert, a split, a reverse - renumbers stations
 * underneath it. The pin stays IN RANGE and starts naming a DIFFERENT REAL STATION, so the engine
 * happily prices a route the diver never asked for and a Save bakes the wrong stations into the
 * `.plnx`. Nothing errors at any point.
 *
 * The fix is not to guess the renumbering: the backend names a station by the shots either side of
 * it, so an anchor survives the edit and can hand back a corrected ref. These tests drive the real
 * store actions against a toy backend that models exactly that - an ordered list of stable station
 * ids, where "delete a station" changes every later index while the stations themselves do not
 * move. Every assertion below therefore distinguishes "followed its station" from "kept its index".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const planAnchorsForRefs = vi.hoisted(() => vi.fn());
const planRefsForAnchors = vi.hoisted(() => vi.fn());
const invokeIpcMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/divePlanApi', () => ({ planAnchorsForRefs, planRefsForAnchors }));
vi.mock('../../utils/ipc', () => ({ invokeIpc: invokeIpcMock }));

import {
  selectComputeGate,
  selectHasPins,
  selectHasUnresolvedPins,
  selectIsPlanDirty,
  useGasPlanStore,
} from '../gasPlanStore';
import { useProjectStore } from '../projectStore';
import { divePlanSnapshotOf } from '../../utils/divePlan';
import type { StationRef } from '../../types/project';

const SECTION = 4;

/**
 * The toy backend's whole model: `order[i]` is the stable id of the station currently at index `i`.
 * An anchor is that id. Deleting a station splices the list, which is what moves every later index.
 */
let order: string[] = [];

/** Rewire the two anchor calls to read the CURRENT `order` on every call. */
function serveAnchors() {
  planAnchorsForRefs.mockImplementation(async (refs: StationRef[]) =>
    refs.map((r) => {
      const id = order[r.station_index];
      return id === undefined ? null : { id };
    })
  );
  planRefsForAnchors.mockImplementation(async (anchors: unknown[]) =>
    anchors.map((a) => {
      const index = order.indexOf((a as { id: string }).id);
      return index < 0 ? null : { section_id: SECTION, station_index: index };
    })
  );
}

const at = (station_index: number): StationRef => ({ section_id: SECTION, station_index });
/** The index the station with id `id` currently sits at. */
const indexOf = (id: string) => order.indexOf(id);

/** Take anchors for whatever is pinned right now (what the mutation seam does before an edit). */
const capture = () => useGasPlanStore.getState().flushAnchorCapture();
const remap = () => useGasPlanStore.getState().remapPinsFromAnchors();

describe('gas-plan pins follow their station across a renumbering edit (#310)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order = ['a', 'b', 'c', 'd', 'e'];
    serveAnchors();
    useGasPlanStore.getState().reset();
  });

  it('is a round-trip identity when nothing renumbered', () => {
    useGasPlanStore.getState().setEndpoint(at(3));
    return capture()
      .then(remap)
      .then(() => {
        expect(useGasPlanStore.getState().endpoint).toEqual(at(3));
        expect(selectHasUnresolvedPins(useGasPlanStore.getState())).toBe(false);
      });
  });

  it('re-points every pin kind after a station is deleted UPSTREAM of it', async () => {
    const g = useGasPlanStore.getState();
    g.setOrigin(at(indexOf('a')));
    g.setEndpoint(at(indexOf('d')));
    g.addWaypoint(at(indexOf('c')));
    g.addMarkedPoint(at(indexOf('e')));
    g.setStageDropOverride(0, at(indexOf('d')));
    await capture();

    order = order.filter((id) => id !== 'b'); // the diver deletes station b in Survey mode
    await remap();

    const after = useGasPlanStore.getState();
    // Each pin is now at the index its OWN station moved to. The positional answer - leaving every
    // index alone - would put the endpoint on 'e' and the way point on 'd': real stations, wrong
    // ones, with a gas number attached that the diver would act on.
    expect(after.origin).toEqual(at(indexOf('a')));
    expect(after.endpoint).toEqual(at(indexOf('d')));
    expect(after.waypoints).toEqual([at(indexOf('c'))]);
    expect(after.markedPoints[0]?.station).toEqual(at(indexOf('e')));
    expect(after.stageDropOverrides[0]).toEqual(at(indexOf('d')));
    // Non-vacuous: the indices really did move.
    expect(after.endpoint).toEqual(at(2));
    expect(after.markedPoints[0]?.station).toEqual(at(3));
  });

  it('blanks the cached field when a pin actually moved, and leaves it alone when none did', async () => {
    useGasPlanStore.getState().setEndpoint(at(indexOf('d')));
    await capture();
    useGasPlanStore.setState({ reachField: { budget_litres: 1 } as never });
    await remap();
    expect(useGasPlanStore.getState().reachField).not.toBeNull();

    order = order.filter((id) => id !== 'b');
    await remap();
    // The painted overlay describes a route through stations the pins have just left.
    expect(useGasPlanStore.getState().reachField).toBeNull();
  });

  it('KEEPS a pin whose station is gone, flags it, and withholds it from the engine', async () => {
    useGasPlanStore.getState().setEndpoint(at(indexOf('d')));
    useGasPlanStore.getState().addWaypoint(at(indexOf('c')));
    await capture();

    order = order.filter((id) => id !== 'd' && id !== 'c');
    await remap();

    const after = useGasPlanStore.getState();
    // Kept, not dropped: an undo of the deletion brings the station back, and silently discarding
    // the diver's chosen lead is worse than showing the plan as stalled.
    expect(after.endpoint).toEqual(at(3));
    expect(after.unresolved.endpoint).toBe(true);
    expect(after.unresolved.waypoints).toEqual([true]);

    const gate = selectComputeGate(after);
    // A way point is a CONSTRAINT the whole field is re-based through, so there is no honest field
    // to draw without it - the plan stalls (#298). The endpoint merely degrades to its default.
    expect(gate.skip).toBe(true);
    expect(gate.endpoint).toBeNull();
  });

  it('clears the flag when a later remap resolves it (a survey undo brings the station back)', async () => {
    useGasPlanStore.getState().setEndpoint(at(indexOf('d')));
    await capture();
    order = order.filter((id) => id !== 'd');
    await remap();
    expect(selectHasUnresolvedPins(useGasPlanStore.getState())).toBe(true);

    order = ['a', 'b', 'c', 'd', 'e']; // Ctrl+Z
    await remap();
    expect(selectHasUnresolvedPins(useGasPlanStore.getState())).toBe(false);
    expect(useGasPlanStore.getState().endpoint).toEqual(at(indexOf('d')));
  });

  it('withholds a flagged stage drop by NULLING its slot, never by removing it', async () => {
    // The array is aligned by index with the field's `stage_drop_refs`, so splicing an entry out
    // would silently move every later stage's drop onto the wrong marker.
    useGasPlanStore.getState().setStageDropOverride(0, at(indexOf('b')));
    useGasPlanStore.getState().setStageDropOverride(1, at(indexOf('e')));
    await capture();
    order = order.filter((id) => id !== 'b');
    await remap();

    const gate = selectComputeGate(useGasPlanStore.getState());
    expect(gate.stageDropOverrides).toHaveLength(2);
    expect(gate.stageDropOverrides[0]).toBeNull();
    expect(gate.stageDropOverrides[1]).toEqual(at(indexOf('e')));
  });

  it('returns the SAME drops array when nothing is flagged (no refetch loop)', () => {
    useGasPlanStore.getState().setStageDropOverride(0, at(2));
    const s = useGasPlanStore.getState();
    // The map subscribes with `useShallow`; a fresh array per call would look like a changed
    // input and re-fetch the reach field on every unrelated store write.
    expect(selectComputeGate(s).stageDropOverrides).toBe(s.stageDropOverrides);
  });

  it('drops a capture reply that raced a pin edit', async () => {
    // The reply is positional WITHIN its request, so scattering it over a pin set that has since
    // changed hands slot N's anchor to a different station - the mis-binding anchors exist to stop.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    planAnchorsForRefs.mockImplementationOnce(async (refs: StationRef[]) => {
      await held;
      return refs.map((r) => ({ id: order[r.station_index] }));
    });

    useGasPlanStore.getState().setEndpoint(at(3));
    const inFlight = capture();
    useGasPlanStore.getState().addWaypoint(at(1)); // the pin set changes mid-flight
    release?.();
    await inFlight;

    // Nothing installed: the anchors described a plan with no way point.
    expect(useGasPlanStore.getState().anchors).toBeNull();
  });

  it('survives the backend refusing the call - the pins keep working positionally', async () => {
    planAnchorsForRefs.mockRejectedValueOnce(new Error('no project open'));
    useGasPlanStore.getState().setEndpoint(at(3));
    await expect(capture()).resolves.toBeUndefined();
    expect(useGasPlanStore.getState().endpoint).toEqual(at(3));
    // And a remap with no anchors is a no-op rather than a crash.
    await expect(remap()).resolves.toBeUndefined();
    expect(useGasPlanStore.getState().endpoint).toEqual(at(3));
  });

  it('skips the whole round trip when the plan pins nothing', async () => {
    expect(selectHasPins(useGasPlanStore.getState())).toBe(false);
    await capture();
    expect(planAnchorsForRefs).not.toHaveBeenCalled();
  });
});

describe('the loaded-plan baseline is re-resolved with the pins (#310)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order = ['a', 'b', 'c', 'd', 'e'];
    serveAnchors();
    useGasPlanStore.getState().reset();
  });

  it('a renumbering edit does not make an untouched plan read as unsaved', async () => {
    useGasPlanStore.getState().setEndpoint(at(indexOf('d')));
    const snapshot = divePlanSnapshotOf(useGasPlanStore.getState());
    useGasPlanStore.getState().applyLoadedPlan(9, snapshot);
    await capture();
    expect(selectIsPlanDirty(useGasPlanStore.getState())).toBe(false);

    order = order.filter((id) => id !== 'b');
    await remap();

    const after = useGasPlanStore.getState();
    expect(after.endpoint).toEqual(at(indexOf('d')));
    // Moving the live pin without the baseline would compare two different numberings and nag a
    // save over a route that is still the same physical route.
    expect(after.loadedPlanBaseline?.endpoint).toEqual(at(indexOf('d')));
    expect(selectIsPlanDirty(after)).toBe(false);
  });

  it('seeds anchors straight from the load reply, with no capture round trip', async () => {
    const snapshot = divePlanSnapshotOf({
      ...useGasPlanStore.getState(),
      endpoint: at(indexOf('d')),
    });
    useGasPlanStore.getState().applyLoadedPlan(9, snapshot, {
      origin: null,
      endpoint: { id: 'd' },
      waypoints: [],
      marked_points: [],
      stage_drop_overrides: [],
    });

    order = order.filter((id) => id !== 'b');
    await remap();

    expect(planAnchorsForRefs).not.toHaveBeenCalled();
    expect(useGasPlanStore.getState().endpoint).toEqual(at(indexOf('d')));
  });
});

/**
 * The mutation seam (`projectStore`), end to end.
 *
 * The ORDER is the whole point: anchors must be taken while the pins still describe the survey the
 * diver placed them on, and re-resolved after the edit but BEFORE the project refetch - the
 * reach-field effect keys on `modified_at`, so a pin corrected after the refetch would have already
 * painted a route through the wrong station.
 */
describe('projectStore re-resolves the plan pins around every mutation (#310)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order = ['a', 'b', 'c', 'd', 'e'];
    serveAnchors();
    useGasPlanStore.getState().reset();
    useProjectStore.setState({ project: null });
  });

  /** Only the fields `refreshProjectState` reads; the survey itself lives in `order`. */
  const projectState = () => ({
    project: {
      created_at: '2026-01-01T00:00:00Z',
      modified_at: '2026-01-01T00:00:01Z',
      sections: [],
      zero_datums: [],
      loop_closures: [],
    },
    stations: [],
    stats: null,
    frozen_shots: [],
  });

  /** The backend applies the edit (b goes away) when the mutation command arrives. */
  function serveDeleteOfB(calls: string[]) {
    invokeIpcMock.mockImplementation(async (command: string) => {
      calls.push(command);
      switch (command) {
        case 'get_project_state':
          return projectState();
        case 'can_undo':
        case 'can_redo':
          return false;
        case 'get_project_warnings':
          return [];
        case 'check_project_integrity':
          return { messages: [], save_blocked: false };
        default:
          order = order.filter((id) => id !== 'b');
          return { success: true, warnings: [], error: null, section_ids: [] };
      }
    });
  }

  it('an endpoint keeps its station across a delete driven through executeCommand', async () => {
    const calls: string[] = [];
    serveDeleteOfB(calls);
    useGasPlanStore.getState().setEndpoint(at(indexOf('d')));

    await useProjectStore.getState().deleteShot(SECTION, 1);

    // 'd' slid from index 3 to index 2. Leaving the pin at 3 would silently re-target 'e'.
    expect(useGasPlanStore.getState().endpoint).toEqual(at(2));
    expect(useGasPlanStore.getState().endpoint).toEqual(at(indexOf('d')));
  });

  it('anchors are taken BEFORE the edit and re-resolved BEFORE the refetch', async () => {
    const calls: string[] = [];
    serveDeleteOfB(calls);
    useGasPlanStore.getState().setEndpoint(at(indexOf('d')));
    // The pin was placed moments ago, so its capture is still sitting on the debounce - exactly
    // the case the seam's flush exists for.
    expect(useGasPlanStore.getState().anchors).toBeNull();

    const seen: string[] = [];
    planAnchorsForRefs.mockImplementation(async (refs: StationRef[]) => {
      seen.push('capture');
      return refs.map((r) => ({ id: order[r.station_index] }));
    });
    planRefsForAnchors.mockImplementation(async (anchors: unknown[]) => {
      seen.push('resolve');
      return anchors.map((a) => {
        const index = order.indexOf((a as { id: string }).id);
        return index < 0 ? null : { section_id: SECTION, station_index: index };
      });
    });

    await useProjectStore.getState().deleteShot(SECTION, 1);

    expect(seen).toEqual(['capture', 'resolve']);
    // And the refetch the reach-field effect keys on ran after the mutation, so the corrected
    // pins were in place before it could paint anything.
    expect(calls).toContain('delete_shot');
    expect(calls.indexOf('delete_shot')).toBeLessThan(calls.lastIndexOf('get_project_state'));
  });

  it('an undo re-resolves too (the numbering flips back)', async () => {
    invokeIpcMock.mockImplementation(async (command: string) => {
      switch (command) {
        case 'get_project_state':
          return projectState();
        case 'can_undo':
        case 'can_redo':
          return false;
        case 'get_project_warnings':
          return [];
        case 'check_project_integrity':
          return { messages: [], save_blocked: false };
        case 'undo':
          order = ['a', 'b', 'c', 'd', 'e'];
          return { success: true, warnings: [], error: null, section_ids: [] };
        default:
          return { success: true, warnings: [], error: null, section_ids: [] };
      }
    });
    order = ['a', 'c', 'd', 'e'];
    useGasPlanStore.getState().setEndpoint(at(indexOf('d')));
    await capture();

    await useProjectStore.getState().undo();

    expect(useGasPlanStore.getState().endpoint).toEqual(at(3));
    expect(useGasPlanStore.getState().endpoint).toEqual(at(indexOf('d')));
  });

  it('costs a plan with no pins nothing at all', async () => {
    const calls: string[] = [];
    serveDeleteOfB(calls);
    await useProjectStore.getState().deleteShot(SECTION, 1);
    expect(planAnchorsForRefs).not.toHaveBeenCalled();
    expect(planRefsForAnchors).not.toHaveBeenCalled();
  });
});
