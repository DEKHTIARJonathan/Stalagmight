/**
 * Unit tests for the unified Open/Import router. These pin the data-loss-sensitive
 * branches of `routeOpenedFile`: the dirty-`.stalx` deferral (must NOT load over an
 * unsaved project), the new-project-only-import rejection (GPX/TML/Compass while a
 * project is open), the unsupported-extension error, and that the pending
 * entry-point telemetry source is cleared on every abandon/reject/null/error
 * branch (so it can't mis-attribute a later, unrelated command).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

const openMock = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

import { routeOpenedFile, pickAndRoute, IMPORT_SURVEY_CLOSE_FIRST } from '../openOrImport';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { setProjectActionSource, peekProjectActionSource } from '../telemetry';

const loadProject = vi.fn().mockResolvedValue({ success: true });
const importDmp = vi.fn().mockResolvedValue(null);
const parseGpx = vi.fn().mockResolvedValue(null);

beforeEach(() => {
  vi.clearAllMocks();
  importDmp.mockResolvedValue(null);
  useUIStore.setState({ activeDialog: null, dialogData: {} });
  useProjectStore.setState({
    project: null,
    isDirty: false,
    loadProject,
    importDmp,
    parseGpx,
  } as never);
  // Each test starts with an armed entry-point source so we can assert clearing.
  setProjectActionSource('keyboard');
});

describe('routeOpenedFile', () => {
  it('defers a .stalx open over a DIRTY project to unsaved-changes (no loadProject)', async () => {
    useProjectStore.setState({ project: { name: 'X' } as never, isDirty: true });
    await routeOpenedFile('/cave/project.stalx');
    expect(useUIStore.getState().activeDialog).toBe('unsaved-changes');
    expect(useUIStore.getState().dialogData).toMatchObject({ pendingOpenPath: '/cave/project.stalx' });
    expect(loadProject).not.toHaveBeenCalled();
    // Handed off to the dialog — the source must survive for the deferred load.
    expect(peekProjectActionSource()).toBe('keyboard');
  });

  it('loads a .stalx directly when no project is open', async () => {
    await routeOpenedFile('/cave/project.stalx');
    expect(loadProject).toHaveBeenCalledWith('/cave/project.stalx');
    expect(useUIStore.getState().activeDialog).not.toBe('unsaved-changes');
  });

  it('rejects a GPX import while a project is open (new-project-only) and clears the source', async () => {
    useProjectStore.setState({ project: { name: 'X' } as never, isDirty: false });
    await routeOpenedFile('/cave/track.gpx');
    expect(useUIStore.getState().activeDialog).toBe('error');
    expect(useUIStore.getState().dialogData).toMatchObject({
      title: IMPORT_SURVEY_CLOSE_FIRST.title,
      message: IMPORT_SURVEY_CLOSE_FIRST.message,
    });
    expect(parseGpx).not.toHaveBeenCalled();
    expect(peekProjectActionSource()).toBeUndefined();
  });

  it('shows an unsupported-file error for an unknown extension and clears the source', async () => {
    await routeOpenedFile('/cave/notes.xyz');
    expect(useUIStore.getState().activeDialog).toBe('error');
    expect(String(useUIStore.getState().dialogData.message)).toContain('Unsupported file type');
    expect(peekProjectActionSource()).toBeUndefined();
  });

  it('clears the source when a DMP parse returns null (abandoned)', async () => {
    importDmp.mockResolvedValue(null);
    await routeOpenedFile('/cave/survey.dmp');
    expect(importDmp).toHaveBeenCalledWith('/cave/survey.dmp');
    // No dialog handed off; the parse bailed → source cleared in finally.
    expect(peekProjectActionSource()).toBeUndefined();
  });
});

describe('pickAndRoute', () => {
  it('clears the source when the picker is cancelled (null result)', async () => {
    openMock.mockResolvedValue(null);
    await pickAndRoute([{ name: 'Project', extensions: ['stalx'] }]);
    expect(peekProjectActionSource()).toBeUndefined();
  });

  it('routes the chosen path through routeOpenedFile (string result)', async () => {
    openMock.mockResolvedValue('/cave/project.stalx');
    await pickAndRoute([{ name: 'Project', extensions: ['stalx'] }]);
    expect(loadProject).toHaveBeenCalledWith('/cave/project.stalx');
  });

  it('clears the source and shows an error when the picker itself throws', async () => {
    openMock.mockRejectedValue(new Error('picker exploded'));
    await pickAndRoute([{ name: 'Project', extensions: ['stalx'] }], 'Open Failed');
    expect(useUIStore.getState().activeDialog).toBe('error');
    expect(peekProjectActionSource()).toBeUndefined();
  });
});
