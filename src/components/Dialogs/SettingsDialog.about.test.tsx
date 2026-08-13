/**
 * Component test (#579) - the About dialog's manual "Check for updates"
 * button: three inline result states (up to date / available / failed),
 * with mocked `invokeIpc`, no toast.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import '../../i18n';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import SettingsDialog from './SettingsDialog';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { defaultConfig } from '../../types/config';

beforeEach(() => {
  invokeIpcMock.mockReset();
  useProjectStore.setState({ config: defaultConfig, updateConfig: vi.fn() });
  useUIStore.setState({
    closeDialog: vi.fn(),
    showToast: vi.fn(),
    dialogData: {},
  });
  useSpeleoStore.setState({ link: null, projectLinkKind: 'local' });
});

async function openAbout() {
  render(<SettingsDialog />);
  await userEvent.click(await screen.findByTestId('settings-about-button'));
  await screen.findByTestId('about-dialog');
}

describe('About "Check for updates" (#579)', () => {
  it('shows "up to date" when the check finds nothing', async () => {
    invokeIpcMock.mockResolvedValue({
      status: { kind: 'up_to_date' },
      current_version: '0.5.0',
    });
    await openAbout();
    await userEvent.click(screen.getByTestId('about-check-updates'));
    const result = await screen.findByTestId('about-check-updates-result');
    expect(result).toHaveTextContent(/up to date/i);
  });

  it('shows the available version when one is on offer', async () => {
    invokeIpcMock.mockResolvedValue({
      status: { kind: 'available', version: '9.9.9', pub_date: null, notes_url: 'https://x' },
      current_version: '0.5.0',
    });
    await openAbout();
    await userEvent.click(screen.getByTestId('about-check-updates'));
    const result = await screen.findByTestId('about-check-updates-result');
    expect(result).toHaveTextContent('9.9.9');
  });

  it('shows a failure state when the check rejects, with no toast', async () => {
    invokeIpcMock.mockRejectedValue(new Error('network down'));
    const showToast = vi.fn();
    useUIStore.setState({ showToast });
    await openAbout();
    await userEvent.click(screen.getByTestId('about-check-updates'));
    const result = await screen.findByTestId('about-check-updates-result');
    expect(result).toHaveTextContent(/could not check/i);
    expect(showToast).not.toHaveBeenCalled();
  });
});
