/**
 * Unit tests for the shared file-action helper used by both the SingleSystemView
 * and GlobalView keyboard dispatchers. The key behavior under test is the
 * New-project unsaved-changes guard (the Ctrl+N data-loss fix): it must defer to
 * the unsaved-changes dialog when a dirty project is open, and open the
 * new-project dialog directly otherwise.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

// Spy on the picker so the read-only guard can be asserted without touching dialogs.
const pickAndRouteMock = vi.fn();
vi.mock('../openOrImport', () => ({
  pickAndRoute: (...args: unknown[]) => pickAndRouteMock(...args),
}));

import { runFileShortcutAction } from '../fileShortcutActions';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore, type SpeleoLinkState } from '../../store/speleoStore';

const READ_ONLY_LINK: SpeleoLinkState = {
  permission: 'READ_AND_WRITE',
  editState: 'read-only',
  lockHolder: 'someone-else',
  lockedByOther: true,
  hasUnpushedEdits: false,
  forceEditing: false,
  forceEditAllowed: false,
  remoteState: 'up_to_date',
  noAccess: false,
  serverError: null,
};

describe('runFileShortcutAction("new_file")', () => {
  beforeEach(() => {
    useUIStore.setState({ activeDialog: null, dialogData: {} });
    useProjectStore.setState({ project: null, isDirty: false });
  });

  it('opens new-project directly when no project is open (GlobalView case)', () => {
    runFileShortcutAction('new_file');
    expect(useUIStore.getState().activeDialog).toBe('new-project');
  });

  it('opens new-project directly when the open project is clean', () => {
    useProjectStore.setState({ project: { name: 'X' } as never, isDirty: false });
    runFileShortcutAction('new_file');
    expect(useUIStore.getState().activeDialog).toBe('new-project');
  });

  it('defers to the unsaved-changes dialog when a dirty project is open (Ctrl+N guard)', () => {
    useProjectStore.setState({ project: { name: 'X' } as never, isDirty: true });
    runFileShortcutAction('new_file');
    expect(useUIStore.getState().activeDialog).toBe('unsaved-changes');
    expect(useUIStore.getState().dialogData).toMatchObject({ pendingNewProject: true });
  });
});

describe('runFileShortcutAction("import_dmp") - read-only-map guard (#243)', () => {
  beforeEach(() => {
    pickAndRouteMock.mockClear();
    useProjectStore.setState({ project: { name: 'X' } as never, isDirty: false });
    useUIStore.setState({ appMode: 'survey', geometryMode: 'measured' });
  });
  afterEach(() => {
    useUIStore.setState({ appMode: 'survey', geometryMode: 'measured' });
    useSpeleoStore.setState({ link: null });
  });

  it('opens the picker in Survey + measured (the editable baseline)', () => {
    runFileShortcutAction('import_dmp');
    expect(pickAndRouteMock).toHaveBeenCalled();
  });

  // Ctrl+I is the third import route the #243 guard had to cover; Plan/Export force
  // closureAdjusted, which falls back to measured on a no-closures project - so a
  // geometryMode-only check would open the picker under the read-only map.
  it('skips the picker in Plan even when geometryMode fell back to measured', () => {
    useUIStore.setState({ appMode: 'plan', geometryMode: 'measured' });
    runFileShortcutAction('import_dmp');
    expect(pickAndRouteMock).not.toHaveBeenCalled();
  });

  it('skips the picker in the closure-adjusted survey view', () => {
    useUIStore.setState({ appMode: 'survey', geometryMode: 'closureAdjusted' });
    runFileShortcutAction('import_dmp');
    expect(pickAndRouteMock).not.toHaveBeenCalled();
  });

  it('opens the picker with NO project (GlobalView) regardless of mode - the guard is project-scoped', () => {
    useProjectStore.setState({ project: null, isDirty: false });
    useUIStore.setState({ appMode: 'plan', geometryMode: 'measured' });
    runFileShortcutAction('import_dmp');
    expect(pickAndRouteMock).toHaveBeenCalled();
  });

  it('skips the picker on a locked remote SpeleoDB project (Survey + measured otherwise editable)', () => {
    useSpeleoStore.setState({ link: READ_ONLY_LINK });
    runFileShortcutAction('import_dmp');
    expect(pickAndRouteMock).not.toHaveBeenCalled();
  });

  it('opens the picker once the SpeleoDB write lock is held', () => {
    useSpeleoStore.setState({ link: { ...READ_ONLY_LINK, editState: 'editing', lockedByOther: false } });
    runFileShortcutAction('import_dmp');
    expect(pickAndRouteMock).toHaveBeenCalled();
  });
});
