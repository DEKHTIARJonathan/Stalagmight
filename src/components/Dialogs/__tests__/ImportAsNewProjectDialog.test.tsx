/**
 * #391: the "import as new project?" confirm dialog that replaces the old
 * close-first dead end for a new-project-only format (GPX/Ariane/Compass/Walls)
 * picked while a project is already open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const closeDialog = vi.fn();
const handleCloseProject = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
  }),
}));

const dialogData: { path?: string; fileName?: string } = {};

vi.mock('../../../store/uiStore', () => ({
  useUIStore: (sel: (s: unknown) => unknown) => sel({ closeDialog, dialogData }),
}));

let projectName: string | undefined;
vi.mock('../../../store/projectStore', () => ({
  useProjectStore: (sel: (s: unknown) => unknown) => sel({ project: projectName ? { name: projectName } : null }),
}));

vi.mock('../../../hooks/useProject', () => ({
  useProject: () => ({ handleCloseProject }),
}));

vi.mock('../../../utils/openOrImport', () => ({ routeOpenedFile: vi.fn() }));

vi.mock('../../../utils/telemetry', () => ({
  trackDialogComplete: vi.fn(),
  clearProjectActionSource: vi.fn(),
}));

vi.mock('../DialogWrapper', () => ({
  DialogWrapper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../common/Button', () => ({
  Button: ({ children, ...rest }: React.ComponentProps<'button'>) => (
    <button {...rest}>{children}</button>
  ),
}));

import { routeOpenedFile } from '../../../utils/openOrImport';
import { trackDialogComplete, clearProjectActionSource } from '../../../utils/telemetry';
import ImportAsNewProjectDialog from '../ImportAsNewProjectDialog';

describe('ImportAsNewProjectDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogData.path = '/cave/track.gpx';
    dialogData.fileName = 'track.gpx';
    projectName = 'My Cave';
    handleCloseProject.mockResolvedValue({ success: true });
  });

  it('renders nothing without a pending path', () => {
    dialogData.path = '';
    const { container } = render(<ImportAsNewProjectDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it('confirming closes the current project then re-routes the picked file', async () => {
    render(<ImportAsNewProjectDialog />);
    fireEvent.click(screen.getByTestId('import-as-new-project-confirm'));

    await waitFor(() => expect(routeOpenedFile).toHaveBeenCalledWith('/cave/track.gpx'));
    expect(trackDialogComplete).toHaveBeenCalledWith('import-as-new-project');
    expect(handleCloseProject).toHaveBeenCalledTimes(1);
    expect(closeDialog).toHaveBeenCalled();
  });

  it('aborts gracefully when the close is deferred to a guard dialog (unsaved changes), clearing the pending source', async () => {
    handleCloseProject.mockResolvedValue({ success: false, error: 'Showing dialog' });
    render(<ImportAsNewProjectDialog />);
    fireEvent.click(screen.getByTestId('import-as-new-project-confirm'));

    await waitFor(() => expect(handleCloseProject).toHaveBeenCalledTimes(1));
    expect(routeOpenedFile).not.toHaveBeenCalled();
    // The guard dialog (unsaved-changes / speleodb-close) now owns the flow -
    // this dialog must not force itself closed on top of it.
    expect(closeDialog).not.toHaveBeenCalled();
    // But the import itself is abandoned here, so the pending entry-point
    // source must not survive to mis-attribute a later, unrelated command.
    expect(clearProjectActionSource).toHaveBeenCalled();
  });

  it('cancelling closes without touching the project or the picked file, clearing the pending source', () => {
    render(<ImportAsNewProjectDialog />);
    fireEvent.click(screen.getByTestId('import-as-new-project-cancel'));
    expect(handleCloseProject).not.toHaveBeenCalled();
    expect(routeOpenedFile).not.toHaveBeenCalled();
    expect(closeDialog).toHaveBeenCalled();
    expect(clearProjectActionSource).toHaveBeenCalled();
  });
});
