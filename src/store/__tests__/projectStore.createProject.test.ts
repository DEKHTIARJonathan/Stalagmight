import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '../projectStore';

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
          displaySettings: {
            showStations: true,
            showSectionNames: true,
            showStationLabels: false,
            showShotData: false,
            showReferenceShots: true,
            showZeroDatum: true,
            showGrid: false,
            showScaleBar: true,
            showSatellite: false,
            showDepthGradient: false,
            gridSpacing: 10,
          },
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
});
