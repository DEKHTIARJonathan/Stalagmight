import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
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

function startLogin() {
  render(
    <SpeleoDbSettings
      config={defaultConfig}
      onChange={onChange}
      changedFields={new Set()}
      onValidationError={vi.fn()}
      panelIdBase="settings-test"
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

it('keeps typed and pasted server endpoints lowercase with keyboard corrections disabled', () => {
  function SettingsHarness() {
    const [config, setConfig] = useState(defaultConfig);
    return (
      <SpeleoDbSettings
        config={config}
        onChange={(patch) => {
          onChange(patch);
          setConfig((current) => ({ ...current, ...patch }));
        }}
        changedFields={new Set()}
        onValidationError={vi.fn()}
        panelIdBase="settings-test"
      />
    );
  }
  render(<SettingsHarness />);
  const endpoint = screen.getByTestId('input-speleodb-endpoint');
  expect(screen.queryByTestId('speleodb-credential-storage')).not.toBeInTheDocument();
  expect(endpoint).toHaveAttribute('autocapitalize', 'none');
  expect(endpoint).toHaveAttribute('autocorrect', 'off');
  expect(endpoint).toHaveAttribute('spellcheck', 'false');
  expect(endpoint).toHaveAttribute('inputmode', 'url');

  fireEvent.change(endpoint, { target: { value: 'Https://' } });
  expect(endpoint).toHaveValue('https://');
  fireEvent.change(endpoint, { target: { value: 'HTTPS://WWW.SPELEODB.ORG/API/' } });
  expect(endpoint).toHaveValue('https://www.speleodb.org/api/');
  expect(onChange).toHaveBeenLastCalledWith({
    speleodb: { ...defaultConfig.speleodb, endpoint: 'https://www.speleodb.org/api/' },
  });

  const reset = screen.getByTestId('setting-speleodb-endpoint-reset');
  expect(reset).toHaveTextContent('Reset');
  fireEvent.click(reset);
  expect(endpoint).toHaveValue(defaultConfig.speleodb.endpoint ?? '');
  expect(reset).toBeDisabled();
  fireEvent.change(endpoint, { target: { value: 'Https://' } });
  fireEvent.change(endpoint, { target: { value: '' } });
  expect(endpoint).toHaveValue('');
  expect(onChange).toHaveBeenLastCalledWith({
    speleodb: { ...defaultConfig.speleodb, endpoint: null },
  });
});
