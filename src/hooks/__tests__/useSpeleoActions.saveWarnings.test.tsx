/**
 * #576 NF-W2SAVE-1 (decided: "Done/Push results carry the pre-push save warnings;
 * frontend shows them"). Done and Push save the project before the upload; a save
 * that went ahead without something (the display settings, the undo history) says
 * so in its warnings, which a normal save shows. The pre-push save's warnings were
 * only logged by the backend. They now ride the Done / Push answer and are shown
 * exactly like a normal save's.
 *
 * `.tsx` so this runs in the jsdom tier (renderHook).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'mock error',
}));

import { useSpeleoActions } from '../useSpeleoActions';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';
import i18n from '../../i18n';

const LOST_DISPLAY = {
  code: 'DISPLAY_SETTINGS_NOT_SAVED',
  message: 'display settings could not be carried',
  severity: 'warning',
};

let showToast: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeIpcMock.mockReset();
  showToast = vi.fn();
  useProjectStore.setState({
    project: { zero_datums: [{}] } as never,
    saveProject: vi.fn(async () => ({ success: true })) as never,
  });
  useSpeleoStore.setState({
    busy: false,
    applyDone: vi.fn(),
    applyPush: vi.fn(),
    bumpPoll: vi.fn(),
    clearSession: vi.fn(),
    raiseNoAnchorBanner: vi.fn(),
  });
  useUIStore.setState({ showToast });
});

const expectSaveWarningShown = () =>
  expect(showToast).toHaveBeenCalledWith(
    i18n.t('saveWarnings.displaySettingsNotSaved'),
    'save-warning:DISPLAY_SETTINGS_NOT_SAVED',
    'warning',
  );

describe('useSpeleoActions: the pre-push save warnings (#576 NF-W2SAVE-1)', () => {
  it('Done shows them like a normal save, and still answers its outcome', async () => {
    invokeIpcMock.mockImplementation(async (cmd: string) =>
      cmd === 'speleodb_done' ? { result: { kind: 'released' }, save_warnings: [LOST_DISPLAY] } : null,
    );
    const { result } = renderHook(() => useSpeleoActions());

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.done();
    });

    expect(outcome).toEqual({ kind: 'released' });
    expectSaveWarningShown();
  });

  it('Push shows them too', async () => {
    invokeIpcMock.mockImplementation(async (cmd: string) =>
      cmd === 'speleodb_push' ? { result: { kind: 'pushed' }, save_warnings: [LOST_DISPLAY] } : null,
    );
    const { result } = renderHook(() => useSpeleoActions());

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.push();
    });

    expect(outcome).toEqual({ kind: 'pushed' });
    expectSaveWarningShown();
  });
});
