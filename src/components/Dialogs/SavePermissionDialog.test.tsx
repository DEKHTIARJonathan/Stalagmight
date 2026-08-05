/**
 * Component test - the folder-access guidance dialog's System Settings
 * deep-link (#415 follow-up). The fix for a permission denial lives outside
 * the app, so on macOS the dialog carries an "Open System Settings" button;
 * a rejected open must degrade to visible inline guidance, never a silent
 * no-op (the useSpeleoWebLink rule).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const openUrlMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: openUrlMock,
}));

const isMacMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/shortcuts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/shortcuts')>()),
  isMac: isMacMock,
}));

import SavePermissionDialog from './SavePermissionDialog';
import { useUIStore } from '../../store/uiStore';

describe('SavePermissionDialog - Open System Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({
      activeDialog: 'save-permission',
      dialogData: { context: 'save' },
    } as never);
  });

  it('opens the Full Disk Access pane on macOS', async () => {
    isMacMock.mockReturnValue(true);
    openUrlMock.mockResolvedValue(undefined);
    render(<SavePermissionDialog />);

    await userEvent.click(screen.getByTestId('save-permission-open-settings'));

    expect(openUrlMock).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    );
    expect(screen.queryByTestId('save-permission-open-settings-failed')).toBeNull();
  });

  it('shows inline guidance when the deep-link is refused, instead of a silent no-op', async () => {
    isMacMock.mockReturnValue(true);
    openUrlMock.mockRejectedValue(new Error('scope denied'));
    render(<SavePermissionDialog />);

    await userEvent.click(screen.getByTestId('save-permission-open-settings'));

    await waitFor(() =>
      expect(screen.getByTestId('save-permission-open-settings-failed')).toBeInTheDocument(),
    );
  });

  it('offers no deep-link off macOS - the written steps stand alone', () => {
    isMacMock.mockReturnValue(false);
    render(<SavePermissionDialog />);

    expect(screen.queryByTestId('save-permission-open-settings')).toBeNull();
  });
});
