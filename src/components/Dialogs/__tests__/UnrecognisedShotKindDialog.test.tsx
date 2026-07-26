/**
 * #27: the unreadable-shot-kind prompt.
 *
 * The backend fails an unrecognised `kind` byte closed to `Reference` so nothing
 * can route through a leg it could not parse. That is safe but it is a
 * substitution the user never agreed to, so the dialog surfaces it. The
 * behaviour that matters here: the safe answer is preselected, and confirming
 * without touching anything must issue NO edits.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const setShotKind = vi.fn().mockResolvedValue({ success: true });
const closeDialog = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const dialogData: { shots?: unknown } = {};

vi.mock('../../../store/uiStore', () => ({
  useUIStore: (sel: (s: unknown) => unknown) =>
    sel({ closeDialog, dialogData }),
}));

vi.mock('../../../store/projectStore', () => ({
  useProjectStore: (sel: (s: unknown) => unknown) => sel({ setShotKind }),
}));

vi.mock('../../../utils/telemetry', () => ({ trackDialogComplete: vi.fn() }));

vi.mock('../DialogWrapper', () => ({
  DialogWrapper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../common/Button', () => ({
  Button: ({ children, ...rest }: React.ComponentProps<'button'>) => (
    <button {...rest}>{children}</button>
  ),
}));

import UnrecognisedShotKindDialog from '../UnrecognisedShotKindDialog';

const shot = (shotId: number, raw: number) => ({
  section_id: 0,
  shot_id: shotId,
  shot_number: shotId + 1,
  section_name: 'Main',
  raw_value: raw,
});

describe('UnrecognisedShotKindDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogData.shots = [shot(1, 7), shot(2, 42)];
  });

  it('renders nothing when there is nothing to resolve', () => {
    dialogData.shots = [];
    const { container } = render(<UnrecognisedShotKindDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the raw stored value so corruption is distinguishable from a newer file', () => {
    render(<UnrecognisedShotKindDialog />);
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('preselects Reference - the fail-closed answer the backend already applied', () => {
    render(<UnrecognisedShotKindDialog />);
    expect(screen.getByTestId('unrecognised-kind-select-1')).toHaveValue('Reference');
    expect(screen.getByTestId('unrecognised-kind-select-2')).toHaveValue('Reference');
  });

  it('issues NO edits when the user accepts the defaults', async () => {
    render(<UnrecognisedShotKindDialog />);
    fireEvent.click(screen.getByTestId('unrecognised-kind-apply'));
    await waitFor(() => expect(closeDialog).toHaveBeenCalled());
    expect(setShotKind).not.toHaveBeenCalled();
  });

  it('issues an edit only for the shots the user actually changed', async () => {
    render(<UnrecognisedShotKindDialog />);
    fireEvent.change(screen.getByTestId('unrecognised-kind-select-1'), {
      target: { value: 'Jump' },
    });
    fireEvent.click(screen.getByTestId('unrecognised-kind-apply'));
    await waitFor(() => expect(closeDialog).toHaveBeenCalled());
    expect(setShotKind).toHaveBeenCalledTimes(1);
    expect(setShotKind).toHaveBeenCalledWith(0, 1, 'Jump');
  });

  it('stays open and explains when an edit is rejected', async () => {
    // setShotKind REPORTS failure rather than throwing (read-only SpeleoDB
    // project, or a lock re-verify that rejects). Closing anyway would lose the
    // user's choices for good: the backend list is already consumed and cannot
    // be re-offered.
    setShotKind.mockResolvedValueOnce({ success: false, error: 'Project is read-only' });
    render(<UnrecognisedShotKindDialog />);
    fireEvent.change(screen.getByTestId('unrecognised-kind-select-1'), {
      target: { value: 'Jump' },
    });
    fireEvent.click(screen.getByTestId('unrecognised-kind-apply'));

    await waitFor(() =>
      expect(screen.getByTestId('unrecognised-kind-error')).toHaveTextContent(
        'Project is read-only',
      ),
    );
    expect(closeDialog).not.toHaveBeenCalled();
    // The user's selection survives, so they can retry once the lock is held.
    expect(screen.getByTestId('unrecognised-kind-select-1')).toHaveValue('Jump');
  });

  it('stops at the first rejection rather than firing the rest', async () => {
    setShotKind.mockResolvedValueOnce({ success: false, error: 'nope' });
    render(<UnrecognisedShotKindDialog />);
    for (const id of [1, 2]) {
      fireEvent.change(screen.getByTestId(`unrecognised-kind-select-${id}`), {
        target: { value: 'Jump' },
      });
    }
    fireEvent.click(screen.getByTestId('unrecognised-kind-apply'));
    await waitFor(() => expect(screen.getByTestId('unrecognised-kind-error')).toBeInTheDocument());
    expect(setShotKind).toHaveBeenCalledTimes(1);
  });

  it('dismissing leaves everything as Reference', () => {
    render(<UnrecognisedShotKindDialog />);
    fireEvent.click(screen.getByText('dialogs.unrecognisedShotKind.keepAsReference'));
    expect(setShotKind).not.toHaveBeenCalled();
    expect(closeDialog).toHaveBeenCalled();
  });
});
