/**
 * #424: the "swap out an already-open project?" confirm, raised by
 * `routeOpenedFile` for every `.stalx`-open entry point (OS launch channel,
 * picker, drag-drop, Ctrl+O) - not just the launch channel it was first built
 * for. `peekProjectActionSource()` only picks the copy variant; the confirm
 * itself is the same for both triggers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

let projectName: string | undefined;
vi.mock('../../../store/projectStore', () => ({
  useProjectStore: (sel: (s: unknown) => unknown) => sel({ project: projectName ? { name: projectName } : null }),
}));

vi.mock('../../../utils/openOrImport', () => ({ routeOpenedFile: vi.fn() }));

let peekedSource: string | undefined;
vi.mock('../../../utils/telemetry', () => ({
  trackDialogComplete: vi.fn(),
  clearProjectActionSource: vi.fn(),
  peekProjectActionSource: () => peekedSource,
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
import LaunchOpenConfirmDialog from '../LaunchOpenConfirmDialog';

describe('LaunchOpenConfirmDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogData.path = '/cave/other.stalx';
    dialogData.fileName = 'other.stalx';
    projectName = 'My Cave';
    peekedSource = 'os-file-association';
  });

  it('renders nothing without a pending path', () => {
    dialogData.path = '';
    const { container } = render(<LaunchOpenConfirmDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it('confirming re-routes the picked file with swapConfirmed: true', async () => {
    render(<LaunchOpenConfirmDialog />);
    fireEvent.click(screen.getByTestId('launch-open-confirm-open'));

    await waitFor(() =>
      expect(routeOpenedFile).toHaveBeenCalledWith('/cave/other.stalx', 'Open Failed', {
        swapConfirmed: true,
      }),
    );
    expect(trackDialogComplete).toHaveBeenCalledWith('launch-open-confirm');
    expect(closeDialog).toHaveBeenCalled();
  });

  it('cancelling closes without routing and clears the pending source', () => {
    render(<LaunchOpenConfirmDialog />);
    fireEvent.click(screen.getByTestId('launch-open-confirm-cancel'));
    expect(routeOpenedFile).not.toHaveBeenCalled();
    expect(closeDialog).toHaveBeenCalled();
    expect(clearProjectActionSource).toHaveBeenCalled();
  });

  it('uses the OS-forwarded copy when the source is os-file-association', () => {
    peekedSource = 'os-file-association';
    render(<LaunchOpenConfirmDialog />);
    expect(screen.getByText(/launchOpenConfirm\.body:/)).toBeInTheDocument();
  });

  it('uses the direct-open copy for a picker/drag-drop/Ctrl+O trigger', () => {
    peekedSource = 'toolbar';
    render(<LaunchOpenConfirmDialog />);
    expect(screen.getByText(/launchOpenConfirm\.bodyDirect:/)).toBeInTheDocument();
  });
});
