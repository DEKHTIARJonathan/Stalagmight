import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { SpeleoDbSettings } from './SpeleoDbSettings';
import { useSpeleoStore } from '../../../store/speleoStore';
import { useUIStore } from '../../../store/uiStore';
import { defaultConfig } from '../../../types/config';

const closeDialog = vi.fn();
const onChange = vi.fn();
let finishLogin: () => void;

beforeEach(() => {
  closeDialog.mockReset();
  onChange.mockReset();
  useUIStore.setState({ activeDialog: 'settings', dialogData: {}, closeDialog });
  useSpeleoStore.setState({
    session: null,
    authError: null,
    refreshSession: vi.fn(async () => {}),
    pendingAuth: { kind: 'login', email: 'synthetic@example.com', password: 'synthetic', token: '', useToken: false },
    applyPendingAuth: vi.fn(() => new Promise<{ ok: true }>((resolve) => {
      finishLogin = () => resolve({ ok: true });
    })),
  });
});

function startLogin(onLoginApplied?: () => boolean, config = defaultConfig) {
  render(
    <SpeleoDbSettings
      config={config}
      onChange={onChange}
      changedFields={new Set()}
      onValidationError={vi.fn()}
      panelIdBase="settings-test"
      {...(onLoginApplied ? { onLoginApplied } : {})}
    />,
  );
  fireEvent.click(screen.getByTestId('speleodb-settings-try-login'));
}

it('closes the Settings instance that initiated a successful login', async () => {
  startLogin();
  await act(async () => finishLogin());
  expect(closeDialog).toHaveBeenCalledOnce();
});

it.each(['error', 'settings'])('does not dismiss a replacement %s dialog after a slow login', async (activeDialog) => {
  startLogin();
  act(() => useUIStore.setState({ activeDialog, dialogData: { replacement: true } }));
  await act(async () => finishLogin());
  expect(closeDialog).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
});

it('logs in over the on-screen connection, including its insecure-HTTP choice', async () => {
  const config = { ...defaultConfig, speleodb: { ...defaultConfig.speleodb, endpoint: 'http://lab.example/', insecure_http: true } };
  startLogin(undefined, config);
  await act(async () => finishLogin());
  expect(useSpeleoStore.getState().applyPendingAuth).toHaveBeenCalledWith('http://lab.example/', true);
});

it('keeps Settings open when its host still has edits staged in other tabs', async () => {
  const onLoginApplied = vi.fn(() => false);
  startLogin(onLoginApplied);
  await act(async () => finishLogin());
  expect(onLoginApplied).toHaveBeenCalledOnce();
  expect(closeDialog).not.toHaveBeenCalled();
});

it('closes once its host has applied the SpeleoDB settings and nothing else is staged', async () => {
  startLogin(() => true);
  await act(async () => finishLogin());
  expect(closeDialog).toHaveBeenCalledOnce();
});
