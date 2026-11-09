/**
 * security#4 - "Log in now" in Settings logs in over the connection ON SCREEN
 * (the staged endpoint and insecure-HTTP choice, never the saved one), applies the
 * SpeleoDB settings on success, and keeps Settings open when other tabs hold
 * staged edits so they are not discarded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
import type { Config } from '../../types/config';

const ENDPOINT = 'http://lab.example/';
const savedConfig: Config = {
  ...defaultConfig,
  speleodb: { ...defaultConfig.speleodb, endpoint: ENDPOINT, insecure_http: false, email: null },
};
let closeDialog: ReturnType<typeof vi.fn>;
let updateConfig: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeIpcMock.mockReset();
  invokeIpcMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'speleodb_login') return { user_email: 'synthetic@example.com', endpoint: ENDPOINT };
    if (cmd === 'get_config') return useProjectStore.getState().config;
    if (cmd === 'speleodb_session') return { logged_in: false };
    if (cmd === 'speleodb_list_projects') return [];
    return null;
  });
  closeDialog = vi.fn();
  updateConfig = vi.fn(async () => ({ success: true }));
  useProjectStore.setState({ config: savedConfig, updateConfig, isDirty: false, project: null });
  useUIStore.setState({
    activeDialog: 'settings', dialogData: { initialCategory: 'speleodb' }, closeDialog, showToast: vi.fn(),
  });
  useSpeleoStore.setState({
    session: null, pendingAuth: null, authError: null, link: null, projectLinkKind: 'local',
    refreshSession: vi.fn(async () => {}), scanLocksOnOpen: vi.fn(async () => {}), refreshLinkStatus: vi.fn(async () => {}),
  });
});

async function logInNow() {
  await userEvent.type(screen.getByTestId('speleodb-settings-email'), 'synthetic@example.com');
  await userEvent.type(screen.getByTestId('speleodb-settings-password'), 'synthetic-pass');
  await userEvent.click(screen.getByTestId('speleodb-settings-try-login'));
}

const loginCall = () => invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_login');

describe('Settings "Log in now" (security#4)', () => {
  it('logs in with the on-screen insecure-HTTP choice, not the saved one, and closes', async () => {
    render(<SettingsDialog />);
    await userEvent.click(await screen.findByTestId('toggle-speleodb-insecure-http'));
    await logInNow();

    await waitFor(() => expect(closeDialog).toHaveBeenCalledOnce());
    expect(loginCall()?.[1]).toMatchObject({ endpoint: ENDPOINT, insecureHttp: true });
    // The backend saved the connection with the session; nothing else needed a Save.
    expect(updateConfig).not.toHaveBeenCalled();
    expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'get_config')).toBe(true);
  });

  it('an unticked on-screen box is sent as such even when the saved choice allows http', async () => {
    useProjectStore.setState({ config: { ...savedConfig, speleodb: { ...savedConfig.speleodb, insecure_http: true } } });
    render(<SettingsDialog />);
    await userEvent.click(await screen.findByTestId('toggle-speleodb-insecure-http'));
    await logInNow();

    await waitFor(() => expect(loginCall()).toBeDefined());
    expect(loginCall()?.[1]).toMatchObject({ insecureHttp: false });
  });

  it('stays open with the other tabs\' edits staged, and the SpeleoDB tab applied', async () => {
    render(<SettingsDialog />);
    await userEvent.click(await screen.findByTestId('settings-tab-general'));
    await userEvent.click(await screen.findByTestId('toggle-auto-save'));
    await userEvent.click(screen.getByTestId('settings-tab-speleodb'));
    await userEvent.click(await screen.findByTestId('toggle-speleodb-insecure-http'));
    await logInNow();

    expect(await screen.findByTestId('speleodb-account-signed-in')).toBeInTheDocument();
    expect(closeDialog).not.toHaveBeenCalled();
    // The SpeleoDB tab no longer reads as changed: its settings were applied.
    expect(screen.getByTestId('setting-speleodb-insecure-http')).not.toHaveClass('bg-accent-5');
    // The general edit is still staged, and Save writes it with the applied section.
    const save = screen.getByTestId('settings-save-button');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(updateConfig).toHaveBeenCalledOnce());
    const written = updateConfig.mock.calls[0][0] as Config;
    expect(written.general.auto_save).toBe(!savedConfig.general.auto_save);
    expect(written.speleodb).toMatchObject({ endpoint: ENDPOINT, insecure_http: true, email: 'synthetic@example.com' });
    expect(invokeIpcMock.mock.calls.filter((c) => c[0] === 'speleodb_login')).toHaveLength(1);
  });

  it('a failed login applies nothing and keeps Settings open', async () => {
    invokeIpcMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'speleodb_login') throw { message: 'Invalid credentials', action: 'ReLogin', status: 400 };
      return null;
    });
    render(<SettingsDialog />);
    await userEvent.click(await screen.findByTestId('toggle-speleodb-insecure-http'));
    await logInNow();

    expect(await screen.findByTestId('speleodb-account-settings-error')).toBeInTheDocument();
    expect(closeDialog).not.toHaveBeenCalled();
    // The on-screen choice is still only staged.
    expect(screen.getByTestId('setting-speleodb-insecure-http')).toHaveClass('bg-accent-5');
  });
});
