import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '../projectStore';
import { useUIStore } from '../uiStore';
import type { DisplaySettings } from '../../types/loading';

const invokeIpcMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
}));

describe('projectStore.createProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    invokeIpcMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'cancel_loading') return undefined;
      if (command === 'list_recent_projects') return [];
      if (command === 'create_project_full') {
        return {
          loadingId: 1n,
          project: {
            name: args?.name ?? 'Untitled Project',
            location: args?.projectLocation ?? null,
            created_at: new Date().toISOString(),
            modified_at: new Date().toISOString(),
            sections: [],
            station_merges: [],
            zero_datums: [],
            loop_closures: [],
            file_path: args?.savePath ?? '/mock/Documents/stalagmight/Untitled_Project.stalx',
            next_section_id: 1,
            section_offsets: {},
            imported_file_hashes: [],
            imported_section_hashes: [],
            next_closure_id: 1n,
          },
          // Complete payload (satisfies pins it): applyDisplaySettings merges
          // with ??, so an omitted field would silently keep prior in-memory
          // state and under-exercise the real create path.
          displaySettings: {
            showStations: true,
            showShots: true,
            showSectionNames: true,
            showStationLabels: false,
            showShotData: false,
            showReferenceShots: true,
        showJumps: true,
            showZeroDatum: true,
            showGrid: false,
            showSatellite: false,
            showDepthGradient: false,
            showStationComments: false,
            showShotComments: false,
            gridSpacing: 10,
            geometryMode: 'measured',
          } satisfies DisplaySettings,
        };
      }
      return undefined;
    });

    useProjectStore.setState({
      project: null,
      stations: [],
      stats: null,
      frozenShots: [],
      warnings: [],
      recentProjects: [],
      error: null,
      isDirty: false,
      loading: {
        loadingId: 0n,
        clientOpId: 0,
        isLoading: false,
        overallProgress: 0,
      },
    });
  });

  it('passes explicit savePath and projectLocation to create_project_full', async () => {
    await useProjectStore.getState().createProject('SaveNow Cave', 'Florida Keys', {
      savePath: '/tmp/custom-save.stalx',
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'create_project_full',
      expect.objectContaining({
        name: 'SaveNow Cave',
        projectLocation: 'Florida Keys',
        savePath: '/tmp/custom-save.stalx',
        deferInitialSave: false,
      }),
      expect.any(Object)
    );
  });

  it('defers initial disk write for default autosave path', async () => {
    await useProjectStore.getState().createProject('Default Docs Cave');

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'create_project_full',
      expect.objectContaining({
        name: 'Default Docs Cave',
        projectLocation: undefined,
        savePath: undefined,
        deferInitialSave: true,
      }),
      expect.any(Object)
    );
  });

  // #54: opening a project must reset the Details panel to the project-level view,
  // i.e. drop any selection carried over from a previous project/session.
  it('clears a stale selection on open', async () => {
    useUIStore.setState({ selection: { type: 'section', sectionId: 1 } });
    expect(useUIStore.getState().selection).not.toBeNull();

    await useProjectStore.getState().createProject('Fresh Cave');

    expect(useUIStore.getState().selection).toBeNull();
  });

  // #275 B1 wiring: the real createProject action (not just the uiStore method)
  // must clear armed tool transients - deleting the reset call site would
  // otherwise pass every unit test while the bug ships.
  it('clears armed tool transients on create (end-to-end wiring)', async () => {
    useUIStore.setState({
      activeTool: 'move_comment',
      moveCommentSource: {
        type: 'shot',
        sectionId: 2,
        shotId: 7,
        comment: 'stale comment from the previous project',
      },
      mergeStationA: { section_id: 1, station_index: 3 },
    });

    await useProjectStore.getState().createProject('Fresh Cave');

    const ui = useUIStore.getState();
    expect(ui.activeTool).toBe('select');
    expect(ui.moveCommentSource).toBeNull();
    expect(ui.mergeStationA).toBeNull();
  });
});
