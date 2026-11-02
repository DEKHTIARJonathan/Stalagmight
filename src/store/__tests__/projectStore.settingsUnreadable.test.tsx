/**
 * [#576 B15] Stored per-project settings the backend could not read on open.
 *
 * The project opens normally with defaults in their place, and every save is
 * refused (`PROJECT_SETTINGS_UNREADABLE`) so the file keeps its stored values.
 * The frontend has to (1) learn WHICH settings from the load result, (2) present a
 * refused save as the blocked action it is - not an error dialog, not Review &
 * Repair - and (3) not let autosave fail on every debounce.
 *
 * `.tsx` is load-bearing: `vite.config.ts` routes only `*.test.tsx` to jsdom, and
 * `renderHook` needs it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useProjectStore } from '../projectStore';
import { useUIStore } from '../uiStore';
import { useSpeleoStore } from '../speleoStore';
import { useAutoSave } from '../../hooks/useAutoSave';
import { surfaceSaveFailure, autosaveFailureMessage } from '../../utils/saveFeedback';
import { classifySaveError, PROJECT_SETTINGS_UNREADABLE } from '../../utils/saveErrors';
import { TOAST_KEYS } from '../../utils/toastKeys';
import i18n from '../../i18n';
import type { DisplaySettings } from '../../types/loading';

const invokeIpcMock = vi.hoisted(() => vi.fn());
const loadBinaryMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/ipc', () => ({ invokeIpc: invokeIpcMock }));
vi.mock('../../utils/loadProjectBinary', () => ({ loadProjectFullBinary: loadBinaryMock }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

const displaySettings: DisplaySettings = {
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
};

/** Resolves the load with the backend's list of unread settings for this file. */
const mockLoad = (unreadableProjectSettings: string[], path: string) =>
  loadBinaryMock.mockResolvedValue({
    loadingId: 1,
    isRemote: false,
    newerSchemaVersion: null,
    unreadableProjectSettings,
    project: {
      name: 'CaveB',
      location: null,
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString(),
      sections: [],
      station_merges: [],
      zero_datums: [],
      loop_closures: [],
      file_path: path,
      next_section_id: 1,
      section_offsets: {},
      imported_file_hashes: [],
      imported_section_hashes: [],
      next_closure_id: 1,
    },
    stations: [],
    surveyData: { shots: [], stations: [] },
    stats: null,
    warnings: [],
    frozen_shots: [],
    displaySettings,
  });

const REFUSAL =
  `${PROJECT_SETTINGS_UNREADABLE}: Can't save: this project's stored entrance elevation could ` +
  'not be read when it was opened. Saving would replace it with defaults, so nothing was ' +
  'written - the file on disk is unchanged. Export still works; close and reopen the project ' +
  'to try again.';

beforeEach(() => {
  vi.clearAllMocks();
  invokeIpcMock.mockImplementation(async (command: string) => {
    if (command === 'list_recent_projects') return [];
    if (command === 'speleodb_link_status') return new Promise(() => {});
    return undefined;
  });
  useSpeleoStore.setState({
    link: null,
    projectLinkKind: 'unknown',
    remoteProjectId: null,
    divergence: null,
    banner: null,
    session: null,
  });
  useProjectStore.setState({
    project: null,
    newerSchemaVersion: null,
    unreadableProjectSettings: [],
    stations: [],
    stats: null,
    frozenShots: [],
    warnings: [],
    recentProjects: [],
    autosaveFailure: null,
    isDirty: false,
    loading: { loadingId: 0, clientOpId: 0, isLoading: false, overallProgress: 0 },
  } as never);
});

describe('loadProject learns which stored settings could not be read', () => {
  it('keeps the list for the project it came with, and the next load replaces it', async () => {
    mockLoad(['validation', 'surface_elevation'], '/mock/CaveB.stalx');
    await useProjectStore.getState().loadProject('/mock/CaveB.stalx');
    expect(useProjectStore.getState().unreadableProjectSettings).toEqual([
      'validation',
      'surface_elevation',
    ]);

    // An ordinary project (the envelope's own default for an absent field is
    // pinned in loadProjectBinary.unreadableSettings.test.ts).
    mockLoad([], '/mock/CaveC.stalx');
    await useProjectStore.getState().loadProject('/mock/CaveC.stalx');
    expect(useProjectStore.getState().unreadableProjectSettings).toEqual([]);
  });

  it('names each setting in words', () => {
    for (const key of ['validation', 'surface_elevation', 'default_azimuth_reference']) {
      const words = i18n.t(`banners.settingsUnreadable.names.${key}`);
      expect(words).not.toBe(`banners.settingsUnreadable.names.${key}`);
      expect(words).not.toContain('_');
    }
  });
});

describe('a save refused over unread settings', () => {
  it('is a warning toast, never an error dialog or Review & Repair', () => {
    const showToast = vi.fn();
    const openDialog = vi.fn();
    const openIntegrityDialog = vi.fn();
    useUIStore.setState({ showToast } as never);
    useProjectStore.setState({ integritySaveBlocked: true, openIntegrityDialog } as never);

    expect(classifySaveError(REFUSAL)).toBe('settings-unreadable');
    surfaceSaveFailure(REFUSAL, openDialog, useProjectStore.getState());

    expect(openDialog).not.toHaveBeenCalled();
    expect(openIntegrityDialog).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      i18n.t('banners.settingsUnreadable.saveRefused'),
      TOAST_KEYS.SETTINGS_UNREADABLE,
      'warning',
    );
    expect(autosaveFailureMessage(REFUSAL)).not.toContain(PROJECT_SETTINGS_UNREADABLE);
    useProjectStore.setState({ integritySaveBlocked: false } as never);
  });
});

describe('autosave while stored settings are unread', () => {
  afterEach(() => {
    vi.useRealTimers();
    useProjectStore.setState({ project: null, isDirty: false, unreadableProjectSettings: [] } as never);
  });

  it('never attempts a save the backend will refuse', async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue({ success: false, error: REFUSAL, warnings: [], section_ids: [] });
    useProjectStore.setState({
      project: { file_path: '/mock/CaveB.stalx' } as never,
      config: { general: { auto_save: true, auto_save_interval_seconds: 1 } } as never,
      isDirty: false,
      integritySaveBlocked: false,
      unreadableProjectSettings: ['surface_elevation'],
      saveProject: save,
    } as never);
    renderHook(() => useAutoSave());

    act(() => {
      useProjectStore.setState({ isDirty: true });
    });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(save).not.toHaveBeenCalled();
  });

  // [#576 RV2-FE-1] The two guards, each on its own: the case above passes with
  // either one deleted.
  it('arm time: an edit does not even start the countdown (the footer stays idle)', async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue({ success: true, warnings: [], section_ids: [] });
    useProjectStore.setState({
      project: { file_path: '/mock/CaveB.stalx' } as never,
      config: { general: { auto_save: true, auto_save_interval_seconds: 1 } } as never,
      isDirty: false,
      integritySaveBlocked: false,
      unreadableProjectSettings: ['surface_elevation'],
      saveProject: save,
    } as never);
    const { result } = renderHook(() => useAutoSave());

    act(() => {
      useProjectStore.setState({ isDirty: true });
    });

    // Without the arm-time guard this reads 'pending' ("Auto-save in 1s") on a
    // project whose every save is refused.
    expect(result.current.status).toBe('idle');
    expect(result.current.countdown).toBe(0);
  });

  it('fire time: a countdown armed before the settings turned unreadable sends nothing', async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue({ success: false, error: REFUSAL, warnings: [], section_ids: [] });
    useProjectStore.setState({
      project: { file_path: '/mock/CaveB.stalx' } as never,
      config: { general: { auto_save: true, auto_save_interval_seconds: 1 } } as never,
      isDirty: false,
      integritySaveBlocked: false,
      unreadableProjectSettings: [],
      saveProject: save,
    } as never);
    const { result } = renderHook(() => useAutoSave());

    act(() => {
      useProjectStore.setState({ isDirty: true });
    });
    expect(result.current.status).toBe('pending');
    // The list fills while the timer runs (the arm-time guard then returns
    // early and leaves the armed timer alone): only the fire-time re-check stops it.
    act(() => {
      useProjectStore.setState({ unreadableProjectSettings: ['surface_elevation'] } as never);
    });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(save).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });
});
