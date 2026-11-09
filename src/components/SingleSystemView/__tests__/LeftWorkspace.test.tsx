import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { LeftWorkspace } from '../LeftWorkspace';
import { useSpeleoStore, type SpeleoLinkState } from '../../../store/speleoStore';
import { useUIStore } from '../../../store/uiStore';
vi.mock('../../../utils/ipc', () => ({ invokeIpc: vi.fn(), getErrorMessage: String }));
vi.mock('../SpeleoWorkspace', () => ({ SpeleoWorkspace: () => <input aria-label="Metadata draft" data-testid="workspace-test-draft" /> }));
const link: SpeleoLinkState = {
  permission: 'READ_AND_WRITE', editState: 'read-only', lockHolder: null,
  lockedByOther: false, hasUnpushedEdits: false, unwound: false,
  undoMode: 'full', remoteState: 'up_to_date', noAccess: false, serverError: null,
};
beforeEach(() => {
  useSpeleoStore.setState({ link });
  useUIStore.setState({ appMode: 'survey', leftWorkspace: 'sections', surveyLeftWorkspace: 'sections' });
});
describe('Left workspace', () => {
  it('opens Sections first and preserves both tab bodies and drafts', () => {
    render(<LeftWorkspace sections={<input aria-label="Sections selection" data-testid="sections-test-selection" />} />);
    const sections = screen.getByRole('tab', { name: 'Sections' });
    expect(sections).toHaveAttribute('aria-selected', 'true');
    fireEvent.change(screen.getByTestId('sections-test-selection'), { target: { value: 'station 42' } });
    fireEvent.click(screen.getByRole('tab', { name: 'SpeleoDB' }));
    const draft = screen.getByRole('textbox', { name: 'Metadata draft' });
    fireEvent.change(draft, { target: { value: 'unfinished' } });
    fireEvent.click(sections);
    expect(draft).not.toBeVisible();
    expect(screen.getByTestId('sections-test-selection')).toHaveValue('station 42');
    fireEvent.click(screen.getByRole('tab', { name: 'SpeleoDB' }));
    expect(screen.getByRole('textbox', { name: 'Metadata draft' })).toBe(draft);
    expect(draft).toHaveValue('unfinished');
  });
  it('implements arrow-key tab navigation and roving focus', () => {
    render(<LeftWorkspace sections={<div />} />);
    const first = screen.getByRole('tab', { name: 'Sections' }); first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'SpeleoDB' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(first).toHaveFocus();
  });
  it('restores the Survey tab after all-mode remote navigation', () => {
    render(<LeftWorkspace sections={<div />} />);
    act(() => useUIStore.getState().setAppMode('plan'));
    expect(screen.queryByRole('tab', { name: 'Sections' })).toBeNull();
    expect(useUIStore.getState().speleoOutsideSurvey).toBe(false);
    act(() => useUIStore.getState().openSpeleoWorkspace('history'));
    expect(useUIStore.getState().speleoOutsideSurvey).toBe(true);
    act(() => useUIStore.getState().setAppMode('survey'));
    expect(screen.getByRole('tab', { name: 'Sections' })).toHaveAttribute('aria-selected', 'true');
  });
  it('exits fullscreen without clearing selection', () => {
    useUIStore.setState({ dataTableFullScreen: true, selection: { type: 'section', sectionId: 42 } });
    act(() => useUIStore.getState().openSpeleoWorkspace());
    expect(useUIStore.getState().dataTableFullScreen).toBe(false);
    expect(useUIStore.getState().selection).toEqual({ type: 'section', sectionId: 42 });
  });
});
