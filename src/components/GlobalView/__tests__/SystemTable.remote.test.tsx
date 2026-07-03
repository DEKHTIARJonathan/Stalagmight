/**
 * Component test (#218) - the SystemTable renders a purely-remote SpeleoDB row and
 * its Open action pulls the project via onOpenRemote.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SystemTable from '../SystemTable';
import type { RecentListItem } from '../recentListItems';
import type { SpeleoProjectSummary } from '../../../types/ipc.generated';

const SUMMARY: SpeleoProjectSummary = {
  id: 'p1',
  name: 'Remote Cave',
  permission: 'READ_AND_WRITE',
  lock_holder: null,
  type_tag: 'stalx',
  latest_commit_sha: null,
};

const REMOTE_ITEM: RecentListItem = { kind: 'remote', projectId: 'p1', summary: SUMMARY };

function renderTable(
  overrides: { onOpenRemote?: ReturnType<typeof vi.fn>; busy?: boolean } = {},
) {
  const onOpenRemote = overrides.onOpenRemote ?? vi.fn();
  render(
    <SystemTable
      items={[REMOTE_ITEM]}
      selectedProjectId={null}
      multiSelectedIds={new Set()}
      sortField="name"
      sortDirection="asc"
      remoteLocks={{ p1: null }}
      remoteProjects={{ p1: 'Remote Cave' }}
      myEmail="me@x"
      onSort={vi.fn()}
      onSelect={vi.fn()}
      onOpen={vi.fn()}
      onContextMenu={vi.fn()}
      onRemoveMissing={vi.fn()}
      onOpenRemote={onOpenRemote}
      busy={overrides.busy ?? false}
    />,
  );
  return { onOpenRemote };
}

describe('SystemTable remote row (#218)', () => {
  it('renders a remote row with the SpeleoDB name', () => {
    renderTable();
    expect(screen.getByTestId('system-row-remote-p1')).toBeInTheDocument();
    expect(screen.getByText('Remote Cave')).toBeInTheDocument();
  });

  it('Open pulls the project via onOpenRemote', async () => {
    const { onOpenRemote } = renderTable();
    await userEvent.click(screen.getByTestId('system-row-remote-open-p1'));
    expect(onOpenRemote).toHaveBeenCalledWith(SUMMARY);
  });

  it('gates the row + Open button while busy (no concurrent open)', async () => {
    const { onOpenRemote } = renderTable({ busy: true });
    const openButton = screen.getByTestId('system-row-remote-open-p1');
    expect(openButton).toBeDisabled();
    // Clicking the disabled button, or the row body, must not fire a second open.
    await userEvent.click(openButton);
    await userEvent.click(screen.getByTestId('system-row-remote-p1'));
    expect(onOpenRemote).not.toHaveBeenCalled();
  });
});
