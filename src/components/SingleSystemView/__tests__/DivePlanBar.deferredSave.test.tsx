/**
 * #275 B3 UI parity: a deferred new project HAS a reserved file_path, but the
 * backend refuses .plnx persistence until the first real save. The bar must
 * gate Save / Save as on databaseOpen (false while deferred), not on
 * file_path alone - otherwise the buttons render enabled during exactly the
 * window the backend refuses, and the needsSavedProject hint stays hidden.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../../utils/divePlanApi', () => ({
  listDivePlans: vi.fn(async () => []),
  loadDivePlan: vi.fn(),
  saveDivePlan: vi.fn(),
  deleteDivePlan: vi.fn(),
}));

import { DivePlanBar } from '../DivePlanBar';
import { useProjectStore } from '../../../store/projectStore';

const projectWithReservedPath = {
  name: 'Deferred Cave',
  created_at: '2026-07-11T00:00:00Z',
  file_path: '/mock/reserved.stalx',
} as never;

describe('DivePlanBar deferred-save gating (#275 B3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables Save as and shows the hint while the initial save is deferred', () => {
    useProjectStore.setState({ project: projectWithReservedPath, databaseOpen: false });
    render(<DivePlanBar />);

    expect(screen.getByTestId('dive-plan-save-as')).toBeDisabled();
    expect(screen.getByTestId('dive-plan-save')).toBeDisabled();
    expect(screen.getByTestId('dive-plan-needs-save')).toBeInTheDocument();
  });

  it('enables Save as once the project database is on disk', () => {
    useProjectStore.setState({ project: projectWithReservedPath, databaseOpen: true });
    render(<DivePlanBar />);

    expect(screen.getByTestId('dive-plan-save-as')).toBeEnabled();
    expect(screen.queryByTestId('dive-plan-needs-save')).not.toBeInTheDocument();
  });
});
