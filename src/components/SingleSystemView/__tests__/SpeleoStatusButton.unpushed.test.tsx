import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SpeleoStatusButton } from '../SpeleoStatusButton';
import { useSpeleoStore, type SpeleoLinkState } from '../../../store/speleoStore';
import { useUIStore } from '../../../store/uiStore';
vi.mock('../../../utils/ipc', () => ({ invokeIpc: vi.fn(), getErrorMessage: String }));
const link: SpeleoLinkState = {
  permission: 'READ_AND_WRITE', editState: 'read-only', lockHolder: null,
  lockedByOther: false, hasUnpushedEdits: false, unwound: false,
  undoMode: 'full', remoteState: 'up_to_date', noAccess: false, serverError: null,
};
beforeEach(() => {
  useUIStore.setState({ appMode: 'survey', leftWorkspace: 'sections', sectionsPanelMode: 'hover', sectionsPanelOpen: false });
  useSpeleoStore.setState({ link, session: null, busy: false });
});
describe('SpeleoDB workspace button', () => {
  it('is absent for local projects', () => {
    useSpeleoStore.setState({ link: null }); render(<SpeleoStatusButton />);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it.each(['survey', 'plan', 'export'] as const)('opens from %s while signed out and read-only without changing panel preferences', (appMode) => {
    useUIStore.setState({ appMode }); render(<SpeleoStatusButton />);
    const button = screen.getByRole('button', { name: 'SpeleoDB' });
    expect(button).toHaveTextContent('SpeleoDB'); expect(button).toBeEnabled();
    const nonce = useUIStore.getState().speleoRevealNonce;
    fireEvent.click(button); fireEvent.click(button);
    expect(useUIStore.getState().leftWorkspace).toBe('speleodb');
    expect(useUIStore.getState().speleoRevealNonce).toBe(nonce + 2);
    expect(useUIStore.getState().sectionsPanelMode).toBe('hover');
    expect(useUIStore.getState().sectionsPanelOpen).toBe(false);
  });
  it('keeps navigation available while busy, and reports work only on this computer', () => {
    useSpeleoStore.setState({ busy: true, link: { ...link, hasUnpushedEdits: true } });
    render(<SpeleoStatusButton />);
    expect(screen.getByTestId('speleodb-status-button')).toBeEnabled();
    expect(screen.getByTestId('speleodb-status-unpushed-badge')).toBeVisible();
  });
  it('has no status action menu on right-click', () => {
    render(<SpeleoStatusButton />); fireEvent.contextMenu(screen.getByRole('button'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(useUIStore.getState().leftWorkspace).toBe('sections');
  });
});
