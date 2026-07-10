/**
 * Component test (#241) — a refused delete+split doesn't silently close as success.
 *
 * The split branch of `handleConfirm` used to discard `deleteShotAndSplit`'s
 * `CommandResult` and unconditionally select + close, so a backend refusal (e.g.
 * a frozen shot) closed the dialog exactly as if it had succeeded, with the user
 * seeing nothing. Mirrors `SplitSectionDialog`'s `result.success === false` handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../utils/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/telemetry')>()),
  trackDialogComplete: vi.fn(),
}));

import ConfirmDialog from './ConfirmDialog';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { CommandResult } from '../../types/commands';

const SECTION_ID = 1;
const SHOT_ID = 2;

let deleteShotAndSplit: ReturnType<typeof vi.fn>;
let closeDialog: ReturnType<typeof vi.fn>;
let setSelection: ReturnType<typeof vi.fn>;

beforeEach(() => {
  deleteShotAndSplit = vi.fn();
  closeDialog = vi.fn();
  setSelection = vi.fn();
  useProjectStore.setState({
    deleteShot: vi.fn(),
    deleteSection: vi.fn(),
    deleteLastShotAndSection: vi.fn(),
    deleteShotAndSplit,
  });
  useUIStore.setState({
    closeDialog,
    clearSelection: vi.fn(),
    setSelection,
    dialogData: {
      type: 'shot',
      sectionId: SECTION_ID,
      shotId: SHOT_ID,
      splitRequired: true,
      sectionName: 'Main Passage',
    },
  });
});

describe('ConfirmDialog delete+split refusal (#241)', () => {
  it('surfaces the backend error and does not close/select when the backend refuses (frozen shot)', async () => {
    deleteShotAndSplit.mockResolvedValue({
      success: false,
      error: 'Cannot delete a frozen shot',
    } as CommandResult);

    render(<ConfirmDialog />);
    fireEvent.click(screen.getByText('Delete & Split'));

    expect(await screen.findByText('Cannot delete a frozen shot')).toBeInTheDocument();
    expect(closeDialog).not.toHaveBeenCalled();
    expect(setSelection).not.toHaveBeenCalled();
  });

  it('selects section A and closes on success', async () => {
    deleteShotAndSplit.mockResolvedValue({ success: true, error: null } as CommandResult);

    render(<ConfirmDialog />);
    fireEvent.click(screen.getByText('Delete & Split'));

    await waitFor(() => expect(closeDialog).toHaveBeenCalled());
    expect(setSelection).toHaveBeenCalledWith({ type: 'section', sectionId: SECTION_ID });
  });
});
