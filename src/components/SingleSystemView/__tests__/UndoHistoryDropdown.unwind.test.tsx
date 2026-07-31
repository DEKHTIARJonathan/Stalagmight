/**
 * [#303] Component test - the Unwind entry pinned below the undo history list.
 *
 * Spec items 17, 18 and 25. What makes it worth testing at this tier: the entry is the
 * ONLY trigger for an action that downloads a revision and replaces the working copy, so
 * three things have to hold together - it appears only where the backend would accept it,
 * pressing it never acts (it opens a confirmation), and the ordinary Undo control is
 * unchanged by its existence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import UndoHistoryDropdown from '../UndoHistoryDropdown';
import { useSpeleoStore } from '../../../store/speleoStore';
import { useProjectStore } from '../../../store/projectStore';
import { useUIStore } from '../../../store/uiStore';

/** A remote link whose write lock we hold (or not), which is what gates the entry. */
const seedLink = (editing: boolean, forceEditing = false) =>
  useSpeleoStore.setState({
    projectLinkKind: 'remote',
    link: {
      permission: 'READ_AND_WRITE',
      editState: editing ? 'editing' : 'read-only',
      lockHolder: null,
      lockedByOther: false,
      hasUnpushedEdits: false,
      forceEditing,
      forceEditAllowed: false,
      undoMode: 'full',
      undoModeOverridden: false,
      remoteState: 'up_to_date',
      noAccess: false,
      serverError: null,
    },
  });

const TARGET = { hexsha: 'abcdef0123456789', is_current: true, discards_unpushed: true };

/** The undo trigger, with the stack empty (`canUndo === false`) unless told otherwise. */
function renderUndo(opts: { disabled?: boolean; hoverable?: boolean } = {}) {
  const onSingleAction = vi.fn();
  render(
    <UndoHistoryDropdown
      mode="undo"
      disabled={opts.disabled ?? true}
      hoverableWhenEmpty={opts.hoverable ?? true}
      onSingleAction={onSingleAction}
      testId="toolbar-undo-button"
      ariaLabel="Undo"
    >
      Undo
    </UndoHistoryDropdown>,
  );
  return { onSingleAction };
}

/** Hover the trigger and wait for the 300ms open delay. */
async function hoverOpen() {
  await userEvent.hover(screen.getByTestId('toolbar-undo-button'));
  await waitFor(
    () => expect(screen.getByTestId('toolbar-undo-button-dropdown')).toBeInTheDocument(),
    { timeout: 2000 },
  );
}

describe('UndoHistoryDropdown - the Unwind entry (#303)', () => {
  beforeEach(() => {
    invokeIpcMock.mockReset();
    invokeIpcMock.mockImplementation((cmd: string) => {
      // An EMPTY undo stack is the state the entry exists for.
      if (cmd === 'get_undo_stack' || cmd === 'get_redo_stack') return Promise.resolve([]);
      if (cmd === 'speleodb_unwind_target') return Promise.resolve(TARGET);
      return Promise.resolve(null);
    });
    useSpeleoStore.setState({ projectLinkKind: 'unknown', link: null });
    useProjectStore.setState({ canUndo: false, canRedo: false });
    useUIStore.setState({ activeDialog: null, dialogData: {} });
  });

  it('appears on an empty stack when the write lock is held (spec 17)', async () => {
    seedLink(true);
    renderUndo();

    await hoverOpen();

    await waitFor(() =>
      expect(screen.getByTestId('toolbar-undo-button-unwind')).toBeInTheDocument(),
    );
    // ...and the panel says what is left rather than a bare "nothing to undo".
    expect(screen.getByText(/Unwind below to load earlier history/)).toBeInTheDocument();
  });

  it('is absent without the write lock (spec 17)', async () => {
    seedLink(false);
    renderUndo();
    await userEvent.hover(screen.getByTestId('toolbar-undo-button'));
    // Nothing to show at all: no items, no unwind, so the panel never opens.
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByTestId('toolbar-undo-button-dropdown')).not.toBeInTheDocument();
    expect(invokeIpcMock).not.toHaveBeenCalledWith('speleodb_unwind_target');
  });

  it('is absent for a force-editor, who holds no lock the backend accepts (spec 17)', async () => {
    // #213: force-editing is edit-enabled WITHOUT a lock, and the backend refuses both
    // the swap and the keep-history waiver there - so the entry must not be offered.
    seedLink(true, true);
    renderUndo();
    await userEvent.hover(screen.getByTestId('toolbar-undo-button'));
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByTestId('toolbar-undo-button-unwind')).not.toBeInTheDocument();
  });

  it('is absent for a local project - there is no history to walk (spec 17)', async () => {
    useSpeleoStore.setState({ projectLinkKind: 'local', link: null });
    renderUndo();
    await userEvent.hover(screen.getByTestId('toolbar-undo-button'));
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByTestId('toolbar-undo-button-unwind')).not.toBeInTheDocument();
  });

  it('is absent when the backend reports no reachable revision (spec 21)', async () => {
    seedLink(true);
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_undo_stack' || cmd === 'get_redo_stack') return Promise.resolve([]);
      // The root of the history, an empty repo, or Disabled mode.
      if (cmd === 'speleodb_unwind_target') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    renderUndo();

    await hoverOpen();
    await waitFor(() => expect(invokeIpcMock).toHaveBeenCalledWith('speleodb_unwind_target'));
    expect(screen.queryByTestId('toolbar-undo-button-unwind')).not.toBeInTheDocument();
  });

  it('never acts on click: it opens the confirmation (spec 18)', async () => {
    seedLink(true);
    renderUndo();
    await hoverOpen();
    await waitFor(() =>
      expect(screen.getByTestId('toolbar-undo-button-unwind')).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByTestId('toolbar-undo-button-unwind'));

    // The dialog is raised with the target, and NOTHING was restored.
    expect(useUIStore.getState().activeDialog).toBe('speleodb-unwind');
    expect(useUIStore.getState().dialogData).toMatchObject({
      hexsha: TARGET.hexsha,
      isCurrent: true,
      // [#303] Carried through, or the confirmation cannot warn on open and the user
      // meets the consequence as a failure after pressing instead.
      discardsUnpushed: true,
    });
    expect(invokeIpcMock).not.toHaveBeenCalledWith(
      'speleodb_restore_revision',
      expect.anything(),
    );
  });

  it('leaves the ordinary Undo control disabled on an empty stack (spec 25)', async () => {
    seedLink(true);
    const { onSingleAction } = renderUndo();

    const trigger = screen.getByTestId('toolbar-undo-button');
    expect(trigger).toBeDisabled();
    // A disabled button fires no click, so Undo / Ctrl+Z still do nothing - the Unwind
    // is deliberately NOT a fall-through from the undo control.
    await userEvent.click(trigger, { pointerEventsCheck: 0 });
    expect(onSingleAction).not.toHaveBeenCalled();
  });

  it('does not open at all when placement mode is the reason for disabled', async () => {
    // The toolbar passes `hoverableWhenEmpty={false}` then: that reason for `disabled`
    // must suppress the panel entirely, not just the button.
    seedLink(true);
    renderUndo({ hoverable: false });

    await userEvent.hover(screen.getByTestId('toolbar-undo-button'));
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByTestId('toolbar-undo-button-dropdown')).not.toBeInTheDocument();
  });

  it('is absent on the REDO side - history only walks backwards', async () => {
    seedLink(true);
    render(
      <UndoHistoryDropdown
        mode="redo"
        disabled={false}
        onSingleAction={vi.fn()}
        testId="toolbar-redo-button"
        ariaLabel="Redo"
      >
        Redo
      </UndoHistoryDropdown>,
    );
    await userEvent.hover(screen.getByTestId('toolbar-redo-button'));
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByTestId('toolbar-redo-button-unwind')).not.toBeInTheDocument();
  });
});
