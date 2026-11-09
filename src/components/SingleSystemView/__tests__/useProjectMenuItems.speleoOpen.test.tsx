/**
 * The hamburger "SpeleoDB" row: with the toolbar SpeleoDB button gone, the left
 * panel's SpeleoDB tab is the entry point, and this row is what reaches it where
 * that tab is not on screen (Plan and Export show no left panel until it is
 * opened; the fullscreen table covers it). Navigation, so it never gates.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
vi.mock('../../../utils/ipc', () => ({ invokeIpc: vi.fn(), getErrorMessage: String }));
import { useProjectMenuItems } from '../useProjectMenuItems';
import { useProjectStore } from '../../../store/projectStore';
import { useSpeleoStore, type SpeleoLinkState } from '../../../store/speleoStore';
import { useUIStore } from '../../../store/uiStore';

const link: SpeleoLinkState = {
  permission: 'READ_AND_WRITE', editState: 'read-only', lockHolder: null,
  lockedByOther: false, hasUnpushedEdits: false, unwound: false,
  undoMode: 'full', remoteState: 'up_to_date', noAccess: false, serverError: null,
};
beforeEach(() => {
  useProjectStore.setState({ project: { file_path: '/synthetic.stalx' } as never });
  useUIStore.setState({ appMode: 'survey', leftWorkspace: 'sections', surveyLeftWorkspace: 'sections',
    sectionsPanelMode: 'hover', sectionsPanelOpen: false, dataTableFullScreen: false, speleoOutsideSurvey: false });
  useSpeleoStore.setState({ link, session: null, busy: false });
});
const row = () => {
  const { result } = renderHook(() => useProjectMenuItems({ onSave: async () => ({ success: true }) }));
  const item = result.current.find((i) => i.id === 'project-menu-speleodb');
  expect(item).toBeDefined();
  return item!;
};

describe('hamburger SpeleoDB row', () => {
  it.each(['survey', 'plan', 'export'] as const)(
    'opens the SpeleoDB tab from %s while signed out and read-only, leaving panel preferences alone',
    (appMode) => {
      useUIStore.setState({ appMode });
      const item = row();
      expect(item.disabled).toBeFalsy();
      const nonce = useUIStore.getState().speleoRevealNonce;
      act(() => (item.onClick as () => void)());
      expect(useUIStore.getState().leftWorkspace).toBe('speleodb');
      expect(useUIStore.getState().speleoRevealNonce).toBe(nonce + 1);
      expect(useUIStore.getState().speleoOutsideSurvey).toBe(appMode !== 'survey');
      expect(useUIStore.getState().sectionsPanelMode).toBe('hover');
      expect(useUIStore.getState().sectionsPanelOpen).toBe(false);
    },
  );

  it('stays available for a local project (it leads to the conversion offer) and while busy', () => {
    useSpeleoStore.setState({ link: null, busy: true });
    const item = row();
    expect(item.disabled).toBeFalsy();
    act(() => (item.onClick as () => void)());
    expect(useUIStore.getState().leftWorkspace).toBe('speleodb');
  });

  it('leaves the fullscreen table, which covers the left panel', () => {
    useUIStore.setState({ dataTableFullScreen: true });
    const item = row();
    act(() => (item.onClick as () => void)());
    expect(useUIStore.getState().dataTableFullScreen).toBe(false);
  });
});
