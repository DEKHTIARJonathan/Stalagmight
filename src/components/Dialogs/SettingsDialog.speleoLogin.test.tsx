/**
 * security#4 / #668 - Connect in Settings saves the staged settings first, then
 * signs in over the connection ON SCREEN (the staged endpoint, and the staged
 * insecure-HTTP value, which only a development build can change), refreshes and
 * closes Settings. A failure applies nothing, keeps Settings open and is shown in
 * an in-app error dialog that names the server that was tried.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import '../../i18n';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (e: unknown) => (e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e)),
}));

import SettingsDialog from './SettingsDialog';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { defaultConfig } from '../../types/config';
import type { Config } from '../../types/config';

const ENDPOINT = 'https://lab.example/';
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
  updateConfig = vi.fn(async (config: Config) => {
    useProjectStore.setState({ config });
    return { success: true };
  });
  useProjectStore.setState({ config: savedConfig, updateConfig, isDirty: false, project: null });
  useUIStore.setState({
    activeDialog: 'settings', dialogData: { initialCategory: 'speleodb' }, closeDialog, showToast: vi.fn(),
  });
  useSpeleoStore.setState({
    session: null, pendingAuth: null, authError: null, link: null, projectLinkKind: 'local',
    refreshSession: vi.fn(async () => {}), scanLocksOnOpen: vi.fn(async () => {}), refreshLinkStatus: vi.fn(async () => {}),
  });
});

async function connect() {
  await userEvent.type(screen.getByTestId('speleodb-settings-email'), 'synthetic@example.com');
  await userEvent.type(screen.getByTestId('speleodb-settings-password'), '[example_password]');
  await userEvent.click(screen.getByTestId('speleodb-settings-try-login'));
}

const loginCall = () => invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_login');

describe('Settings Connect', () => {
  it('signs in with the connection on screen and closes Settings', async () => {
    render(<SettingsDialog />);
    await screen.findByTestId('speleodb-settings-try-login');
    await connect();

    await waitFor(() => expect(closeDialog).toHaveBeenCalledOnce());
    expect(loginCall()?.[1]).toMatchObject({ endpoint: ENDPOINT, insecureHttp: false });
  });

  it('sends the staged insecure-HTTP value, not the saved one', async () => {
    // No control changes it in a release build; a staged value still wins.
    useProjectStore.setState({ config: { ...savedConfig, speleodb: { ...savedConfig.speleodb, insecure_http: true } } });
    render(<SettingsDialog />);
    await screen.findByTestId('speleodb-settings-try-login');
    await connect();

    await waitFor(() => expect(loginCall()).toBeDefined());
    expect(loginCall()?.[1]).toMatchObject({ insecureHttp: true });
  });

  it('saves the other tabs\' staged edits before it signs in, so closing discards nothing', async () => {
    render(<SettingsDialog />);
    await userEvent.click(await screen.findByTestId('settings-tab-general'));
    await userEvent.click(await screen.findByTestId('toggle-auto-save'));
    await userEvent.click(screen.getByTestId('settings-tab-speleodb'));
    await connect();

    await waitFor(() => expect(closeDialog).toHaveBeenCalledOnce());
    expect(updateConfig).toHaveBeenCalledOnce();
    const written = updateConfig.mock.calls[0]?.[0] as Config;
    expect(written.general.auto_save).toBe(!savedConfig.general.auto_save);
    const saveOrder = updateConfig.mock.invocationCallOrder[0] ?? Infinity;
    const loginIndex = invokeIpcMock.mock.calls.findIndex((c) => c[0] === 'speleodb_login');
    expect(saveOrder).toBeLessThan(invokeIpcMock.mock.invocationCallOrder[loginIndex] ?? -1);
  });

  it('a failed sign-in applies no session, keeps Settings open and shows the error in a dialog', async () => {
    invokeIpcMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'speleodb_login') throw { message: 'Invalid credentials', action: 'ReLogin', status: 400 };
      return null;
    });
    render(<SettingsDialog />);
    await screen.findByTestId('speleodb-settings-try-login');
    await connect();

    const dialog = await screen.findByTestId('speleodb-connection-error');
    expect(dialog).toHaveTextContent('Could not sign in to SpeleoDB: Invalid credentials');
    expect(closeDialog).not.toHaveBeenCalled();
    expect(useSpeleoStore.getState().session).toBeNull();
  });
});

describe('Settings Connect failure feedback', () => {
  const failWith = (error: unknown) => invokeIpcMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'speleodb_login') throw error;
    if (cmd === 'get_config') return useProjectStore.getState().config;
    return null;
  });

  it('names the server on screen, not "the configured server", when it cannot be reached', async () => {
    failWith({ message: 'Network error talking to SpeleoDB: refused', action: 'Retry', status: null, transport: 'Refused' });
    render(<SettingsDialog />);
    const endpoint = await screen.findByTestId('input-speleodb-endpoint');
    await userEvent.clear(endpoint);
    await userEvent.type(endpoint, 'https://unsaved.example/');
    await connect();

    const dialog = await screen.findByTestId('speleodb-connection-error');
    expect(dialog).toHaveTextContent('Could not connect to SpeleoDB at https://unsaved.example/.');
    expect(dialog).not.toHaveTextContent('configured server');
  });

  it('explains a plain-HTTP refusal with the automatic exceptions', async () => {
    failWith({
      message: 'HTTPS is required. HTTP is allowed only on localhost, 127.0.0.1 or 192.168.x.x. Rejected endpoint: http://lab.example/',
      action: 'Fatal', status: null, transport: null, endpoint_refusal: 'PlainHttp',
    });
    render(<SettingsDialog />);
    await screen.findByTestId('speleodb-settings-try-login');
    await connect();

    const dialog = await screen.findByTestId('speleodb-connection-error');
    expect(dialog).toHaveTextContent(ENDPOINT);
    expect(dialog).toHaveTextContent('HTTPS is required');
    expect(dialog).toHaveTextContent('192.168.x.x');
    expect(dialog).not.toHaveTextContent('Rejected endpoint');
  });
});
