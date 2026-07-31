/**
 * [#303] Component test - spec item 29: the per-project undo-history control renders the
 * effective value, distinguishes an override from the inherited default, is disabled
 * without the write lock WITH the reason visible, and writes through on change.
 *
 * The distinction it exists to keep honest: "Full" set on the project and "Full"
 * inherited from the application default are different states, and only the latter keeps
 * tracking a later change to that default - so collapsing them would make "use the
 * default" look like a no-op.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { SpeleoUndoModeControl } from '../SpeleoUndoModeControl';
import { useSpeleoStore } from '../../../../store/speleoStore';
import type { UndoMode } from '../../../../types/ipc.generated';

/** A remote link in the given edit state, carrying the given undo policy. */
const seed = (opts: {
  editing: boolean;
  undoMode?: UndoMode;
  overridden?: boolean;
  forceEditing?: boolean;
}) =>
  useSpeleoStore.setState({
    projectLinkKind: 'remote',
    link: {
      permission: 'READ_AND_WRITE',
      editState: opts.editing ? 'editing' : 'read-only',
      lockHolder: null,
      lockedByOther: false,
      hasUnpushedEdits: false,
      forceEditing: opts.forceEditing ?? false,
      forceEditAllowed: false,
      undoMode: opts.undoMode ?? 'full',
      undoModeOverridden: opts.overridden ?? false,
      remoteState: 'up_to_date',
      noAccess: false,
      serverError: null,
    },
  });

describe('SpeleoUndoModeControl (#303)', () => {
  beforeEach(() => {
    invokeIpcMock.mockReset();
    invokeIpcMock.mockResolvedValue(null);
    useSpeleoStore.setState({ projectLinkKind: 'unknown', link: null });
  });

  it('renders the effective value and says where it came from', () => {
    seed({ editing: true, undoMode: 'disabled', overridden: true });
    render(<SpeleoUndoModeControl />);

    expect(screen.getByTestId('speleodb-undo-mode-disabled-input')).toBeChecked();
    expect(screen.getByTestId('speleodb-undo-mode-full-input')).not.toBeChecked();
    // Set on the project, so the "use the default" escape is offered.
    expect(screen.getByTestId('speleodb-undo-mode-provenance').textContent).toBe(
      'Set on this project',
    );
    expect(screen.getByTestId('speleodb-undo-mode-use-default')).toBeInTheDocument();
  });

  it('says it is following the application default when there is no override', () => {
    seed({ editing: true, undoMode: 'full', overridden: false });
    render(<SpeleoUndoModeControl />);

    expect(screen.getByTestId('speleodb-undo-mode-provenance').textContent).toBe(
      'Following the application default',
    );
    // Nothing to clear, so no escape hatch - offering it would be a no-op control.
    expect(screen.queryByTestId('speleodb-undo-mode-use-default')).not.toBeInTheDocument();
  });

  it('writes the chosen mode through and re-reads the resolved value', async () => {
    seed({ editing: true, undoMode: 'full' });
    render(<SpeleoUndoModeControl />);

    await userEvent.click(screen.getByTestId('speleodb-undo-mode-disabled-input'));

    await waitFor(() =>
      expect(invokeIpcMock).toHaveBeenCalledWith('speleodb_set_undo_mode', { mode: 'disabled' }),
    );
    // ...and re-reads, because the backend resolves `null` against the global default
    // and the control renders the resolved answer rather than assuming its own.
    await waitFor(() =>
      expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_link_status')).toBe(true),
    );
  });

  it('clears the override with an explicit action rather than a mode press', async () => {
    seed({ editing: true, undoMode: 'full', overridden: true });
    render(<SpeleoUndoModeControl />);

    await userEvent.click(screen.getByTestId('speleodb-undo-mode-use-default'));

    // `null`, not 'full': the two are different states on the wire, and only NULL keeps
    // following a later change to the application default.
    await waitFor(() =>
      expect(invokeIpcMock).toHaveBeenCalledWith('speleodb_set_undo_mode', { mode: null }),
    );
  });

  it('is disabled without the write lock, and says why', () => {
    seed({ editing: false });
    render(<SpeleoUndoModeControl />);

    expect(screen.getByTestId('speleodb-undo-mode-full-input')).toBeDisabled();
    expect(screen.getByTestId('speleodb-undo-mode-disabled-input')).toBeDisabled();
    // The reason is VISIBLE: a greyed control with no explanation reads as a bug, and
    // this one is gated for a reason the user can act on (start editing).
    expect(screen.getByTestId('speleodb-undo-mode-lock-hint')).toBeInTheDocument();
  });

  it('is disabled for a force-editor, who holds no lock the backend would accept', () => {
    // #213: force-editing is edit-enabled WITHOUT a lock, so the backend refuses the
    // write. An enabled control there could only ever fail.
    seed({ editing: true, forceEditing: true });
    render(<SpeleoUndoModeControl />);

    expect(screen.getByTestId('speleodb-undo-mode-full-input')).toBeDisabled();
    expect(screen.getByTestId('speleodb-undo-mode-lock-hint')).toBeInTheDocument();
  });

  it('surfaces a refusal inline instead of throwing it away', async () => {
    seed({ editing: true });
    invokeIpcMock.mockRejectedValueOnce(new Error('acquire the write lock first'));
    render(<SpeleoUndoModeControl />);

    await userEvent.click(screen.getByTestId('speleodb-undo-mode-disabled-input'));

    await waitFor(() =>
      expect(screen.getByTestId('speleodb-undo-mode-error')).toBeInTheDocument(),
    );
  });
});
