import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGasPlanStore } from '../store/gasPlanStore';
import { useProjectStore } from '../store/projectStore';
import { speleoProjectSessionIssuedFor, useSpeleoStore } from '../store/speleoStore';
import { useUIStore } from '../store/uiStore';
import { applySpeleoTreeReplacement } from './speleoTreeReplacement';

let refreshProjectState: ReturnType<typeof vi.fn>;
let checkProjectIntegrity: ReturnType<typeof vi.fn>;
let refreshLinkStatus: ReturnType<typeof vi.fn>;

beforeEach(() => {
  refreshProjectState = vi.fn(async () => {});
  checkProjectIntegrity = vi.fn(async () => []);
  refreshLinkStatus = vi.fn(async () => {});
  useProjectStore.setState({
    refreshProjectState,
    checkProjectIntegrity,
    isDirty: true,
  });
  useSpeleoStore.setState({
    session: null,
    sessionGeneration: 0,
    remoteProjectId: 'p1',
    refreshLinkStatus,
  });
  useUIStore.setState({
    view: 'global',
    activeTool: 'merge',
    selection: { type: 'station', stationRef: { section_id: 1, station_index: 2 } },
    multiSelection: [
      { type: 'station', stationRef: { section_id: 1, station_index: 2 } },
    ],
    mergeStationA: { section_id: 1, station_index: 2 },
    mergeStationB: { section_id: 1, station_index: 3 },
    commentTarget: {
      type: 'shot',
      sectionId: 1,
      shotId: 7,
      screenPos: { x: 10, y: 20 },
      currentComment: 'old tree',
    },
    measureStart: { kind: 'point', x: 1, y: 2, z: 3 },
  });
  useGasPlanStore.getState().reset();
  useGasPlanStore.getState().setEndpoint({ section_id: 1, station_index: 2 });
});

describe('applySpeleoTreeReplacement', () => {
  it('reconciles every store that owns per-tree state', async () => {
    const applied = await applySpeleoTreeReplacement(speleoProjectSessionIssuedFor('p1'));

    expect(applied).toBe(true);
    expect(useUIStore.getState()).toMatchObject({
      view: 'single',
      activeTool: 'select',
      selection: null,
      multiSelection: [],
      mergeStationA: null,
      mergeStationB: null,
      commentTarget: null,
      measureStart: null,
    });
    expect(useGasPlanStore.getState().endpoint).toBeNull();
    expect(refreshProjectState).toHaveBeenCalledOnce();
    expect(useProjectStore.getState().isDirty).toBe(false);
    expect(checkProjectIntegrity).toHaveBeenCalledOnce();
    expect(refreshLinkStatus).toHaveBeenCalledOnce();
  });

  it('does not touch the new project when the captured identity is stale', async () => {
    const issuedFor = speleoProjectSessionIssuedFor('p1');
    useSpeleoStore.setState({ remoteProjectId: 'p2' });

    const applied = await applySpeleoTreeReplacement(issuedFor);

    expect(applied).toBe(false);
    expect(useUIStore.getState().selection).not.toBeNull();
    expect(useGasPlanStore.getState().endpoint).not.toBeNull();
    expect(refreshProjectState).not.toHaveBeenCalled();
    expect(checkProjectIntegrity).not.toHaveBeenCalled();
    expect(refreshLinkStatus).not.toHaveBeenCalled();
    expect(useProjectStore.getState().isDirty).toBe(true);
  });
});
