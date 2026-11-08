/**
 * #649 - a project saved by a newer Stalagmight is refused by the backend with
 * `NEWER_SCHEMA`. Retry and repair cannot help, so the load hands it to the
 * error dialog with the one remedy (update) instead of the loading panel.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import { useProjectStore } from '../projectStore';
import { useUIStore } from '../uiStore';

const invokeIpcMock = vi.hoisted(() => vi.fn());
const loadBinaryMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/ipc', () => ({ invokeIpc: invokeIpcMock }));
vi.mock('../../utils/loadProjectBinary', () => ({ loadProjectFullBinary: loadBinaryMock }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

/** The one wording, as the backend's `NewerSchema` Display and `en.json` both say it. */
const WORDING =
  '"cave.stalx" was saved by a newer version of Stalagmight (file format 19; this version reads up to 18). Update Stalagmight to open it.';

/** The backend's refusal, in the shape `parseLoadError` reads. */
const REFUSAL = {
  code: 'NEWER_SCHEMA',
  message: WORDING,
  details: '/surveys/cave.stalx',
  newerSchema: { file: 'cave.stalx', found: 19, supported: 18 },
};

beforeEach(() => {
  vi.clearAllMocks();
  loadBinaryMock.mockRejectedValue(REFUSAL);
  invokeIpcMock.mockImplementation(async (command: string) => {
    if (command === 'list_recent_projects') return [];
    return undefined;
  });
  useUIStore.setState({ activeDialog: null, dialogData: {}, view: 'global' });
  useProjectStore.setState({
    project: null,
    loading: { loadingId: 0n, clientOpId: 0, isLoading: false, overallProgress: 0 },
  });
});

describe('loadProject NEWER_SCHEMA (#649)', () => {
  it('opens the error dialog naming the update, and leaves no loading panel', async () => {
    const result = await useProjectStore.getState().loadProject('/surveys/cave.stalx');

    expect(result.success).toBe(false);
    const ui = useUIStore.getState();
    expect(ui.activeDialog).toBe('error');
    expect(ui.dialogData).toEqual({
      title: i18n.t('newerSchema.open.title'),
      message: WORDING,
      hideReportHint: true,
    });
    // Rendered from the localized string with the payload's values, not relayed.
    expect(i18n.t('newerSchema.open.title')).not.toBe('newerSchema.open.title');
    const { loading } = useProjectStore.getState();
    expect(loading.isLoading).toBe(false);
    expect(loading.error).toBeUndefined();
    expect(ui.view).toBe('global');
  });

  it('interpolates the payload rather than relaying the backend text', async () => {
    loadBinaryMock.mockRejectedValue({
      ...REFUSAL,
      message: 'backend text',
      newerSchema: { file: 'other.stalx', found: 25, supported: 18 },
    });

    await useProjectStore.getState().loadProject('/surveys/other.stalx');

    expect(useUIStore.getState().dialogData.message).toBe(
      '"other.stalx" was saved by a newer version of Stalagmight (file format 25; this version reads up to 18). Update Stalagmight to open it.'
    );
  });

  it('falls back to the backend wording when the payload is missing', async () => {
    loadBinaryMock.mockRejectedValue({ ...REFUSAL, newerSchema: undefined });

    await useProjectStore.getState().loadProject('/surveys/cave.stalx');

    expect(useUIStore.getState().dialogData.message).toBe(WORDING);
  });

  it('stays quiet when a newer load took over', async () => {
    loadBinaryMock.mockImplementation(async () => {
      useProjectStore.setState((s) => ({ loading: { ...s.loading, clientOpId: s.loading.clientOpId + 99 } }));
      throw REFUSAL;
    });

    const result = await useProjectStore.getState().loadProject('/surveys/cave.stalx');

    expect(result.success).toBe(false);
    expect(useUIStore.getState().activeDialog).toBeNull();
  });
});
