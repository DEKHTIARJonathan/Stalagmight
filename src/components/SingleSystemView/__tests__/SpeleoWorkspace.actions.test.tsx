/**
 * The SpeleoDB tab's everyday actions: a disabled one says why in its tooltip (a
 * disabled control must not be a dead end), and `speleoPrimaryAction` names the
 * one action that makes sense now, the only filled button; every other action
 * keeps its colour as an outline (docs/style-guide.md, Buttons).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const ipc = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/ipc', () => ({ invokeIpc: ipc, getErrorMessage: String }));

import { SpeleoWorkspace, speleoPrimaryAction } from '../SpeleoWorkspace';
import { useProjectStore } from '../../../store/projectStore';
import { useSpeleoStore, type SpeleoLinkState } from '../../../store/speleoStore';
import { useUIStore } from '../../../store/uiStore';

const LINK: SpeleoLinkState = {
  permission: 'READ_AND_WRITE', editState: 'read-only', lockHolder: null,
  lockedByOther: false, hasUnpushedEdits: false, unwound: false,
  undoMode: 'full', remoteState: 'up_to_date', noAccess: false, serverError: null,
};
const SESSION = { loggedIn: true, userEmail: 'me@example.com', endpoint: 'https://synthetic.example' };

const save = () => screen.getByTestId('speleodb-workspace-upload');
const editing = () => screen.getByTestId('speleodb-workspace-editing');
const reload = () => screen.getByTestId('speleodb-workspace-latest');
const web = () => screen.getByTestId('speleodb-workspace-open-web');

beforeEach(() => {
  ipc.mockReset();
  ipc.mockResolvedValue(null);
  useProjectStore.setState({ project: { name: 'Synthetic cave', file_path: '/synthetic.stalx', zero_datums: [] } as never, isDirty: false });
  useUIStore.setState({ appMode: 'survey', speleoWorkspaceSection: null });
  useSpeleoStore.setState({ link: LINK, remoteProjectId: 'synthetic', busy: false, session: SESSION });
});

describe('speleoPrimaryAction', () => {
  it.each([
    ['editing, nothing to save', { editState: 'editing' as const }, true, true, false, null],
    ['editing with unsaved edits', { editState: 'editing' as const }, true, true, true, 'save'],
    ['editing with un-uploaded edits', { editState: 'editing' as const, hasUnpushedEdits: true }, true, true, false, 'save'],
    ['unsaved edits while read-only', {}, false, false, true, 'save'],
    ['signed out, clean', {}, false, false, false, 'editing'],
    ['signed out, un-uploaded edits', { hasUnpushedEdits: true }, false, false, false, 'editing'],
    ['signed in, can resume', {}, true, true, false, 'editing'],
    ['signed in, un-uploaded edits', { hasUnpushedEdits: true }, true, true, false, 'save'],
    ['signed in, view-only', { permission: 'READ_ONLY' as const }, true, false, false, null],
    ['signed in, view-only, un-uploaded edits', { permission: 'READ_ONLY' as const, hasUnpushedEdits: true }, true, false, false, null],
  ])('%s', (_label, link, signedIn, canResume, dirty, expected) => {
    expect(speleoPrimaryAction({ ...LINK, ...link }, signedIn, canResume, dirty)).toBe(expected);
  });
});

describe('SpeleoDB tab everyday actions', () => {
  const filled = () => [save(), editing(), reload(), screen.getByTestId('speleodb-workspace-close'), web()]
    .filter((b) => b.hasAttribute('data-filled'))
    .map((b) => b.getAttribute('data-testid'));
  /** An outline: the tone's border and its 10% wash, never a solid fill. */
  const expectOutline = (b: HTMLElement) => {
    expect(b).not.toHaveAttribute('data-filled');
    expect(b.className).toMatch(/(^|\s)border(\s|$)/);
    expect(b.className).toMatch(/(^|\s)bg-[a-z]+-10(\s|$)/);
  };

  it.each<[string, Partial<SpeleoLinkState>, typeof SESSION | null, boolean, string[]]>([
    ['editing with changes', { editState: 'editing' as const }, SESSION, true, ['speleodb-workspace-upload']],
    ['editing, nothing to save', { editState: 'editing' as const }, SESSION, false, []],
    ['read-only, able to resume editing', {}, SESSION, false, ['speleodb-workspace-editing']],
    ['read-only with un-uploaded edits', { hasUnpushedEdits: true }, SESSION, false, ['speleodb-workspace-upload']],
    ['signed out', {}, null, false, ['speleodb-workspace-editing']],
    ['view-only access', { permission: 'READ_ONLY' as const }, SESSION, false, []],
  ])('%s: fills only the action that makes sense now, every other an outline', (_label, link, session, isDirty, expected) => {
    useSpeleoStore.setState({ link: { ...LINK, ...link }, session });
    useProjectStore.setState({ isDirty });
    render(<SpeleoWorkspace />);
    expect(filled()).toEqual(expected);
    for (const b of [save(), editing(), reload(), screen.getByTestId('speleodb-workspace-close'), web()]) {
      if (!expected.includes(b.getAttribute('data-testid')!)) expectOutline(b);
    }
  });

  it('the filled action keeps its own colour: Save the accent, Resume editing and Connect green', () => {
    useProjectStore.setState({ isDirty: true });
    const { unmount } = render(<SpeleoWorkspace />);
    expect(save().className).toContain('bg-accent ');
    unmount();
    useProjectStore.setState({ isDirty: false });
    render(<SpeleoWorkspace />);
    expect(editing().className).toContain('bg-success ');
    expect(save().className).toContain('border-accent-text');
  });

  it('Close Project and Switch to Read Only Mode are neutral outlines, not red or amber', () => {
    useSpeleoStore.setState({ link: { ...LINK, editState: 'editing' } });
    render(<SpeleoWorkspace />);
    for (const b of [screen.getByTestId('speleodb-workspace-close'), editing()]) {
      expect(b.className).toContain('border-neutral-border');
      expect(b.className).not.toMatch(/error|warning/);
    }
    expect(editing()).toHaveTextContent('Switch to Read Only Mode');
    expect(reload().className).toContain('text-info-text');
    expect(web().className).toContain('text-external-text');
  });

  it('signed out on a read-only copy: the disabled ones say why', () => {
    useSpeleoStore.setState({ session: null });
    render(<SpeleoWorkspace />);
    expect(editing()).toHaveTextContent('Sign in to resume editing');
    expect(reload()).toBeDisabled();
    expect(reload()).toHaveAttribute('title', 'Sign in to SpeleoDB to reload this project from the server.');
    expect(web()).toBeDisabled();
    expect(web()).toHaveAttribute('title', 'Sign in to SpeleoDB to open this project on the web.');
  });

  it('editing: nothing carries a reason', () => {
    useSpeleoStore.setState({ link: { ...LINK, editState: 'editing' } });
    render(<SpeleoWorkspace />);
    for (const button of [save(), editing(), reload(), web()]) {
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute('title');
    }
  });

  it('signed in and able to resume: Resume editing is offered and enabled', () => {
    render(<SpeleoWorkspace />);
    expect(editing()).toHaveTextContent('Resume editing');
    expect(editing()).toBeEnabled();
  });

  it.each([
    ['view-only access', { permission: 'READ_ONLY' as const }, 'Read-only - your SpeleoDB access does not allow editing'],
    ['no access', { noAccess: true }, 'Your SpeleoDB account has no access to this project.'],
    ['permission not known yet', { permission: null }, 'SpeleoDB has not said yet whether your account can edit this project.'],
  ])('signed in with %s: Resume editing is disabled and says why', (_label, link, reason) => {
    useSpeleoStore.setState({ link: { ...LINK, ...link } });
    render(<SpeleoWorkspace />);
    expect(editing()).toBeDisabled();
    expect(editing()).toHaveAttribute('title', reason);
  });

  it('while another SpeleoDB operation runs, the disabled buttons say to wait', () => {
    useSpeleoStore.setState({ busy: true });
    render(<SpeleoWorkspace />);
    for (const button of [save(), editing(), reload(), screen.getByTestId('speleodb-workspace-close')]) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Wait for the current SpeleoDB operation to finish.');
    }
  });
});
