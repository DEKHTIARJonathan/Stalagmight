/**
 * [#576 RV9b-3] Settings > Advanced "Reload from disk" re-reads the config, and
 * every config re-read outside a save runs in the config chain (#576 NF-W8FE-4,
 * `reloadConfigInOrder`): issued while a settings save is in flight, it could
 * answer with the file as it was before the save and land in the store after the
 * save's own re-read - putting back a config without the save. This one called
 * `reload_config` and `setConfig` straight away. It now waits its turn in the
 * chain, and puts its answer into the store there.
 *
 * `.tsx` so vitest runs it under jsdom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../utils/ipc');

import { AdvancedSettings } from './AdvancedSettings';
import { defaultConfig } from '../../../types/config';
import type { Config } from '../../../types/config';
import { useProjectStore } from '../../../store/projectStore';
import { chainSettingWrite, SETTING_KEYS } from '../../../utils/settingWriteChain';
import { invokeIpcMock } from '../../../test/factories/ipc';
import { actMicrotasks } from '../../../test/factories/act';

const RELOADED: Config = { ...defaultConfig, logging: { ...defaultConfig.logging, max_directory_size_mb: 321 } };

beforeEach(() => {
  invokeIpcMock.mockReset();
  invokeIpcMock.mockImplementation(async (cmd: string) => (cmd === 'reload_config' ? RELOADED : null));
  useProjectStore.setState({ config: defaultConfig });
});

const renderAdvanced = () =>
  render(
    <AdvancedSettings
      config={defaultConfig}
      onChange={vi.fn()}
      changedFields={new Set()}
      onValidationError={vi.fn()}
      panelIdBase="settings"
    />,
  );

const reloadCalls = () => invokeIpcMock.mock.calls.filter((call) => call[0] === 'reload_config');

describe('Settings > Advanced: Reload from disk waits for a settings save in flight (#576 RV9b-3)', () => {
  it('reads the file only after the save ahead of it in the config chain, and stores its answer', async () => {
    // A settings save in flight, holding the config chain.
    let finishSave: () => void = () => {};
    const save = chainSettingWrite(SETTING_KEYS.config, () => new Promise<void>((resolve) => { finishSave = resolve; }));
    renderAdvanced();

    fireEvent.click(screen.getByTestId('reload-config-button'));
    await actMicrotasks(5);
    expect(reloadCalls()).toHaveLength(0);
    expect(useProjectStore.getState().config).toBe(defaultConfig);

    finishSave();
    await save;
    await waitFor(() => expect(reloadCalls()).toHaveLength(1));
    await waitFor(() => expect(useProjectStore.getState().config).toBe(RELOADED));
  });

  it('pin: with nothing in flight it reloads at once', async () => {
    renderAdvanced();

    fireEvent.click(screen.getByTestId('reload-config-button'));
    await waitFor(() => expect(useProjectStore.getState().config).toBe(RELOADED));
    expect(reloadCalls()).toHaveLength(1);
  });
});
