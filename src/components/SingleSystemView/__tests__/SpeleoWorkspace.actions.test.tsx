/**
 * The SpeleoDB tab's everyday actions: a disabled one says why in its tooltip (a
 * disabled control must not be a dead end), and `speleoPrimaryAction` names the
 * one action that makes sense now. The buttons take #668's colour-by-kind
 * variants for now; filling only that action is the follow-up (see the todo).
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
    ['editing', { editState: 'editing' as const }, true, true, false, 'save'],
    ['unsaved edits while read-only', {}, false, false, true, 'save'],
    ['signed out, clean', {}, false, false, false, 'editing'],
    ['signed out, un-uploaded edits', { hasUnpushedEdits: true }, false, false, false, 'editing'],
    ['signed in, can resume', {}, true, true, false, 'editing'],
    ['signed in, un-uploaded edits', { hasUnpushedEdits: true }, true, true, false, 'save'],
    ['signed in, view-only', { permission: 'READ_ONLY' as const }, true, false, false, null],
  ])('%s', (_label, link, signedIn, canResume, dirty, expected) => {
    expect(speleoPrimaryAction({ ...LINK, ...link }, signedIn, canResume, dirty)).toBe(expected);
  });
});

describe('SpeleoDB tab everyday actions', () => {
  it.todo('fills only the action speleoPrimaryAction names, every other button an outline or tint');

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
