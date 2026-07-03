/**
 * Component test (#218) - the read-only revision-history view. Fetches
 * speleodb_get_revisions on mount and renders the commit chain, plus the empty and
 * error states.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'error',
}));

import SpeleoRevisionsDialog from './SpeleoRevisionsDialog';
import { useUIStore } from '../../store/uiStore';
import type { SpeleoRevision } from '../../types/ipc.generated';

const REVISIONS: SpeleoRevision[] = [
  {
    id: 'aaaaaaaa1111',
    parent_ids: ['bbbbbbbb2222', 'cccccccc3333'],
    author_email: 'me@x',
    authored_date: '2026-07-03T10:00:00+00:00',
    message: 'merge branch',
  },
  {
    id: 'bbbbbbbb2222',
    parent_ids: [],
    author_email: 'you@x',
    authored_date: null,
    message: 'root commit',
  },
];

beforeEach(() => {
  invokeIpcMock.mockReset();
  useUIStore.setState({
    closeDialog: vi.fn(),
    dialogData: { projectId: 'p1', projectName: 'Cave A' },
  });
});

describe('SpeleoRevisionsDialog (#218)', () => {
  it('fetches and renders the commit chain', async () => {
    invokeIpcMock.mockResolvedValue(REVISIONS);
    render(<SpeleoRevisionsDialog />);

    await waitFor(() => expect(screen.getByTestId('speleodb-revisions-list')).toBeInTheDocument());
    const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_get_revisions');
    expect(call?.[1]).toEqual({ projectId: 'p1' });
    // Short SHA (8 chars), author, message, and a merge marker for the >1-parent commit.
    expect(screen.getByText('aaaaaaaa')).toBeInTheDocument();
    expect(screen.getByText('me@x')).toBeInTheDocument();
    expect(screen.getByText('merge branch')).toBeInTheDocument();
    expect(screen.getByText('root commit')).toBeInTheDocument();
    expect(screen.getByTestId('speleodb-revision-aaaaaaaa1111')).toBeInTheDocument();
  });

  it('shows the empty state for a project with no revisions', async () => {
    invokeIpcMock.mockResolvedValue([]);
    render(<SpeleoRevisionsDialog />);
    await waitFor(() => expect(screen.getByTestId('speleodb-revisions-empty')).toBeInTheDocument());
  });

  it('shows an error state when the fetch fails', async () => {
    invokeIpcMock.mockRejectedValue({ message: 'offline', action: 'Retry', status: null });
    render(<SpeleoRevisionsDialog />);
    await waitFor(() => expect(screen.getByTestId('speleodb-revisions-error')).toBeInTheDocument());
  });
});
