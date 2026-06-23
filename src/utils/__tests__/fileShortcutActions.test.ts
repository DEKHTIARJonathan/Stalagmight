/**
 * Unit tests for the shared file-action helper used by both the SingleSystemView
 * and GlobalView keyboard dispatchers. The key behavior under test is the
 * New-project unsaved-changes guard (the Ctrl+N data-loss fix): it must defer to
 * the unsaved-changes dialog when a dirty project is open, and open the
 * new-project dialog directly otherwise.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

import { runFileShortcutAction } from '../fileShortcutActions';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';

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
