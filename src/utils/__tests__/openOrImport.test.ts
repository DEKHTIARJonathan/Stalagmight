/**
 * Unit tests for the unified Open/Import router. These pin the data-loss-sensitive
 * branches of `routeOpenedFile`: the dirty-`.stalx` deferral (must NOT load over an
 * unsaved project), the new-project-only-import rejection (GPX/TML/Compass while a
 * project is open), the unsupported-extension error, and that the pending
 * entry-point telemetry source is cleared on every abandon/reject/null/error
 * branch (so it can't mis-attribute a later, unrelated command).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

const openMock = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

import { routeOpenedFile, pickAndRoute } from '../openOrImport';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore, type SpeleoLinkState } from '../../store/speleoStore';
import { setProjectActionSource, peekProjectActionSource } from '../telemetry';

const READ_ONLY_LINK: SpeleoLinkState = {
  permission: 'READ_AND_WRITE',
  editState: 'read-only',
  lockHolder: 'someone-else',
  lockedByOther: true,
  hasUnpushedEdits: false,
  unwound: false,
  forceEditing: false,
  forceEditAllowed: false,
  undoMode: 'full',
  remoteState: 'up_to_date',
  noAccess: false,
  serverError: null,
};

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
  // The open project (where a test opens one) is a CONFIRMED-local project: the
  // SpeleoDB read-only gate fails closed since #270, so the editable baseline has
  // to say so rather than leave the gate unresolved.
  useSpeleoStore.setState({ link: null, projectLinkKind: 'local' });
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
    // Handed off to the dialog - the source must survive for the deferred load.
    expect(peekProjectActionSource()).toBe('keyboard');
  });

  it('loads a .stalx directly when no project is open', async () => {
    await routeOpenedFile('/cave/project.stalx');
    expect(loadProject).toHaveBeenCalledWith('/cave/project.stalx');
    expect(useUIStore.getState().activeDialog).not.toBe('unsaved-changes');
  });

  it('raises the swap-confirm dialog for a .stalx over a CLEAN project instead of opening directly', async () => {
    useProjectStore.setState({ project: { name: 'X' } as never, isDirty: false });
    await routeOpenedFile('/cave/other.stalx');
    expect(useUIStore.getState().activeDialog).toBe('launch-open-confirm');
    expect(useUIStore.getState().dialogData).toMatchObject({
      path: '/cave/other.stalx',
      fileName: 'other.stalx',
    });
    expect(loadProject).not.toHaveBeenCalled();
    // Handed off to the dialog - the source must survive for confirm to complete it.
    expect(peekProjectActionSource()).toBe('keyboard');
  });

  it('opens on confirm: swapConfirmed skips the dialog and re-enters at loadProject', async () => {
    useProjectStore.setState({ project: { name: 'X' } as never, isDirty: false });
    await routeOpenedFile('/cave/other.stalx', 'Open Failed', { swapConfirmed: true });
    expect(useUIStore.getState().activeDialog).not.toBe('launch-open-confirm');
    expect(loadProject).toHaveBeenCalledWith('/cave/other.stalx');
  });

  it('cancel (never re-invoking) leaves the current project untouched', async () => {
    useProjectStore.setState({ project: { name: 'X' } as never, isDirty: false });
    await routeOpenedFile('/cave/other.stalx');
    expect(useUIStore.getState().activeDialog).toBe('launch-open-confirm');
    // No re-route follows - a decline never calls routeOpenedFile again.
    expect(loadProject).not.toHaveBeenCalled();
    expect(useProjectStore.getState().project).toEqual({ name: 'X' });
  });

  it('offers "import as new project?" for a GPX import while a project is open, handing off the source', async () => {
    useProjectStore.setState({ project: { name: 'X' } as never, isDirty: false });
    await routeOpenedFile('/cave/track.gpx');
    expect(useUIStore.getState().activeDialog).toBe('import-as-new-project');
    expect(useUIStore.getState().dialogData).toMatchObject({
      path: '/cave/track.gpx',
      fileName: 'track.gpx',
    });
    expect(parseGpx).not.toHaveBeenCalled();
    // Handed off to the dialog - the source must survive until it resolves.
    expect(peekProjectActionSource()).toBe('keyboard');
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

describe('routeOpenedFile - read-only-map import guard (#243)', () => {
  beforeEach(() => {
    useProjectStore.setState({ project: { name: 'X' } as never, isDirty: false });
  });
  // Reset the mode so a case that sets Plan/adjusted can't leak into later tests.
  afterEach(() => {
    useUIStore.setState({ appMode: 'survey', geometryMode: 'measured' });
    useSpeleoStore.setState({ link: null, projectLinkKind: 'local' });
  });

  it('allows a DMP import in Survey + measured (the editable baseline)', async () => {
    useUIStore.setState({ appMode: 'survey', geometryMode: 'measured' });
    await routeOpenedFile('/cave/survey.dmp');
    expect(importDmp).toHaveBeenCalledWith('/cave/survey.dmp');
    expect(useUIStore.getState().activeDialog).not.toBe('error');
  });

  it('blocks a DMP import in the closure-adjusted survey view with the import-blocked prompt (cause: view)', async () => {
    useUIStore.setState({ appMode: 'survey', geometryMode: 'closureAdjusted' });
    await routeOpenedFile('/cave/survey.dmp');
    expect(importDmp).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeDialog).toBe('import-blocked');
    expect(useUIStore.getState().dialogData).toMatchObject({ path: '/cave/survey.dmp', cause: 'view' });
  });

  // The regression the #243 guard closes: Plan/Export force closureAdjusted, but that
  // auto-reverts to 'measured' on a no-closures project, so a geometryMode-only guard
  // would let the import through and mutate the survey under the read-only map.
  // Mode-only blocking raises the import-blocked CHOICE dialog (not an error): the
  // fix is one safe click, and the dialog carries the picked path so "Switch to
  // Survey" can continue this exact import.
  it('blocks a DMP import in Plan even when geometryMode fell back to measured (import-blocked prompt)', async () => {
    useUIStore.setState({ appMode: 'plan', geometryMode: 'measured' });
    await routeOpenedFile('/cave/survey.dmp');
    expect(importDmp).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeDialog).toBe('import-blocked');
    expect(useUIStore.getState().dialogData).toMatchObject({ path: '/cave/survey.dmp', cause: 'mode' });
  });

  it('blocks a DMP import in Export (measured fallback) with the same import-blocked prompt', async () => {
    useUIStore.setState({ appMode: 'export', geometryMode: 'measured' });
    await routeOpenedFile('/cave/survey.dmp');
    expect(importDmp).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeDialog).toBe('import-blocked');
  });

  it('still opens a native .stalx in Plan (opening a project is not an import)', async () => {
    useProjectStore.setState({ project: null, isDirty: false });
    useUIStore.setState({ appMode: 'plan', geometryMode: 'measured' });
    await routeOpenedFile('/cave/project.stalx');
    expect(loadProject).toHaveBeenCalledWith('/cave/project.stalx');
    expect(useUIStore.getState().activeDialog).not.toBe('error');
  });

  it('blocks a DMP import on a locked remote SpeleoDB project (Survey + measured otherwise editable)', async () => {
    useUIStore.setState({ appMode: 'survey', geometryMode: 'measured' });
    useSpeleoStore.setState({ link: READ_ONLY_LINK });
    await routeOpenedFile('/cave/survey.dmp');
    expect(importDmp).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeDialog).toBe('error');
    expect(String(useUIStore.getState().dialogData.message)).toContain('SpeleoDB write lock');
  });

  // Compound read-only state (#275): a locked remote project ALSO viewed in a
  // non-survey mode must still mention the write lock, not just "switch to Survey" -
  // silently dropping the SpeleoDB cause from the message would leave the user
  // stuck after switching modes with no lock acquired.
  it('mentions the SpeleoDB write lock even when ALSO in Plan mode (compound state)', async () => {
    useUIStore.setState({ appMode: 'plan', geometryMode: 'measured' });
    useSpeleoStore.setState({ link: READ_ONLY_LINK });
    await routeOpenedFile('/cave/survey.dmp');
    expect(importDmp).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeDialog).toBe('error');
    const message = String(useUIStore.getState().dialogData.message);
    expect(message).toContain('SpeleoDB write lock');
    expect(message).toContain('Survey mode');
  });

  // The switch-and-continue re-route from ImportBlockedDialog: the one cause a
  // switch cannot fix (the SpeleoDB write lock) must inform via toast and get
  // out of the way - the user already clicked once.
  it('reports a residual SpeleoDB-lock cause as a toast, not a second modal, when re-routed with residualReadOnlyToast', async () => {
    useUIStore.setState({ appMode: 'survey', geometryMode: 'measured' });
    useSpeleoStore.setState({ link: READ_ONLY_LINK });
    await routeOpenedFile('/cave/survey.dmp', 'Import Failed', { residualReadOnlyToast: true });
    expect(importDmp).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeDialog).toBeNull();
    const toasts = useUIStore.getState().toasts;
    expect(JSON.stringify(toasts)).toContain('SpeleoDB write lock');
  });

  it('allows a DMP import once the SpeleoDB write lock is held', async () => {
    useUIStore.setState({ appMode: 'survey', geometryMode: 'measured' });
    useSpeleoStore.setState({ link: { ...READ_ONLY_LINK, editState: 'editing', lockedByOther: false } });
    await routeOpenedFile('/cave/survey.dmp');
    expect(importDmp).toHaveBeenCalledWith('/cave/survey.dmp');
    expect(useUIStore.getState().activeDialog).not.toBe('error');
  });
});

describe('routeOpenedFile - the read-only guard is scoped to DMP only (#392)', () => {
  beforeEach(() => {
    useProjectStore.setState({ project: { name: 'X' } as never, isDirty: false });
    useUIStore.setState({ appMode: 'plan', geometryMode: 'measured' });
  });
  afterEach(() => {
    useUIStore.setState({ appMode: 'survey', geometryMode: 'measured' });
    useSpeleoStore.setState({ link: null, projectLinkKind: 'local' });
  });

  it('still offers "import as new project?" for a TML while editing is blocked (close-and-import does not mutate)', async () => {
    await routeOpenedFile('/cave/track.tml');
    expect(useUIStore.getState().activeDialog).toBe('import-as-new-project');
    expect(useUIStore.getState().dialogData).toMatchObject({
      path: '/cave/track.tml',
      fileName: 'track.tml',
    });
    // Handed off to the dialog, not cleared as a reject.
    expect(peekProjectActionSource()).toBe('keyboard');
  });

  it('still blocks a DMP import while editing is blocked, via the import-blocked prompt that hands off the source', async () => {
    await routeOpenedFile('/cave/survey.dmp');
    expect(importDmp).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeDialog).toBe('import-blocked');
    // The dialog owns the source now: "Switch to Survey" continues this import
    // (source survives into the DMP flow); a cancel clears it via
    // checkDialogCancel, not the router's finally.
    expect(peekProjectActionSource()).toBe('keyboard');
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
