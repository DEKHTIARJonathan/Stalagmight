/**
 * #674: the open-or-add prompt raised when a `.stalx` is picked through an
 * in-project Import door.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const closeDialog = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
  }),
}));

const dialogData: { path?: string; fileName?: string } = {};

vi.mock('../../../store/uiStore', () => ({
  useUIStore: (sel: (s: unknown) => unknown) => sel({ closeDialog, dialogData }),
}));

vi.mock('../../../store/projectStore', () => ({
  useProjectStore: (sel: (s: unknown) => unknown) => sel({ project: { name: 'My Cave' } }),
}));

let blocked = false;
vi.mock('../../../hooks/useEditingBlocked', () => ({
  useEditingBlocked: () => blocked,
  isEditingBlockedNow: () => blocked,
}));

vi.mock('../../../utils/openOrImport', () => ({ routeOpenedFile: vi.fn() }));
vi.mock('../../../utils/addProjectFile', () => ({ runAddProjectFile: vi.fn() }));

vi.mock('../../../utils/telemetry', () => ({
  trackDialogComplete: vi.fn(),
  clearProjectActionSource: vi.fn(),
}));

vi.mock('../DialogWrapper', () => ({
  DialogWrapper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { routeOpenedFile } from '../../../utils/openOrImport';
import { runAddProjectFile } from '../../../utils/addProjectFile';
import { trackDialogComplete, clearProjectActionSource } from '../../../utils/telemetry';
import AddOrOpenProjectDialog from '../AddOrOpenProjectDialog';

describe('AddOrOpenProjectDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    blocked = false;
    dialogData.path = '/cave/other.stalx';
    dialogData.fileName = 'other.stalx';
  });

  it('renders nothing without a pending path', () => {
    dialogData.path = '';
    const { container } = render(<AddOrOpenProjectDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the open project on the Add choice', () => {
    render(<AddOrOpenProjectDialog />);
    expect(screen.getByTestId('add-or-open-project-add').textContent).toContain('My Cave');
  });

  it('"Open as project" re-routes through the guarded open and never adds', () => {
    render(<AddOrOpenProjectDialog />);
    fireEvent.click(screen.getByTestId('add-or-open-project-open'));
    expect(closeDialog).toHaveBeenCalled();
    expect(routeOpenedFile).toHaveBeenCalledWith('/cave/other.stalx', 'Open Failed', { swapConfirmed: true });
    expect(runAddProjectFile).not.toHaveBeenCalled();
    expect(trackDialogComplete).toHaveBeenCalledWith('add-or-open-project');
  });

  it('"Add to" appends the file and never opens it as a project', () => {
    render(<AddOrOpenProjectDialog />);
    fireEvent.click(screen.getByTestId('add-or-open-project-add'));
    expect(closeDialog).toHaveBeenCalled();
    expect(runAddProjectFile).toHaveBeenCalledWith('/cave/other.stalx');
    expect(routeOpenedFile).not.toHaveBeenCalled();
    expect(trackDialogComplete).toHaveBeenCalledWith('add-or-open-project');
  });

  it('Add is disabled and inert while editing is blocked, but Open as project still works', () => {
    blocked = true;
    render(<AddOrOpenProjectDialog />);
    const add = screen.getByTestId('add-or-open-project-add') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.getByTestId('add-or-open-project-blocked')).toBeTruthy();
    fireEvent.click(add);
    expect(runAddProjectFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('add-or-open-project-open'));
    expect(routeOpenedFile).toHaveBeenCalledTimes(1);
  });

  it('Add stays inert if editing becomes blocked after render (click-time re-check)', () => {
    render(<AddOrOpenProjectDialog />);
    blocked = true;
    fireEvent.click(screen.getByTestId('add-or-open-project-add'));
    expect(runAddProjectFile).not.toHaveBeenCalled();
    expect(closeDialog).not.toHaveBeenCalled();
  });

  it('Cancel abandons the add and drops the pending source without routing', () => {
    render(<AddOrOpenProjectDialog />);
    fireEvent.click(screen.getByTestId('add-or-open-project-cancel'));
    expect(clearProjectActionSource).toHaveBeenCalled();
    expect(closeDialog).toHaveBeenCalled();
    expect(routeOpenedFile).not.toHaveBeenCalled();
    expect(runAddProjectFile).not.toHaveBeenCalled();
  });
});
