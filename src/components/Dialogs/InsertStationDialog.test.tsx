/**
 * Component test (#59) — Insert Station dialog validates the split distance
 * and only closes/selects on a genuine backend success, mirroring
 * ConfirmDialog's result-check + failure-surfacing convention.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../utils/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/telemetry')>()),
  trackDialogComplete: vi.fn(),
}));

import InsertStationDialog from './InsertStationDialog';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { Project, SectionId, ShotId } from '../../types/project';
import type { CommandResult } from '../../types/commands';

const SECTION_ID = 1 as SectionId;
const SHOT_ID = 2 as ShotId;
const SHOT_LENGTH = 10;

let splitShotAtDistance: ReturnType<typeof vi.fn>;
let closeDialog: ReturnType<typeof vi.fn>;
let setSelection: ReturnType<typeof vi.fn>;

beforeEach(() => {
  splitShotAtDistance = vi.fn();
  closeDialog = vi.fn();
  setSelection = vi.fn();
  useProjectStore.setState({
    // The dialog only reads project.sections and section.shots[].id to find
    // the split shot's post-split (unchanged) position.
    project: {
      sections: [{ id: SECTION_ID, shots: [{ id: SHOT_ID, length: SHOT_LENGTH }] }],
    } as unknown as Project,
    splitShotAtDistance,
  });
  useUIStore.setState({
    activeDialog: 'insert-station',
    closeDialog,
    setSelection,
    dialogData: {
      sectionId: SECTION_ID,
      shotId: SHOT_ID,
      shotLength: SHOT_LENGTH,
      sectionName: 'Main Passage',
    },
  });
});

describe('InsertStationDialog (#59)', () => {
  it('disables confirm when the distance field is empty', () => {
    render(<InsertStationDialog />);
    expect(screen.getByTestId('insert-station-confirm')).toBeDisabled();
  });

  it('disables confirm at distance = 0', () => {
    render(<InsertStationDialog />);
    fireEvent.change(screen.getByTestId('insert-station-distance'), { target: { value: '0' } });
    expect(screen.getByTestId('insert-station-confirm')).toBeDisabled();
  });

  it('disables confirm at distance = the shot length', () => {
    render(<InsertStationDialog />);
    fireEvent.change(screen.getByTestId('insert-station-distance'), {
      target: { value: String(SHOT_LENGTH) },
    });
    expect(screen.getByTestId('insert-station-confirm')).toBeDisabled();
  });

  it('enables confirm strictly between 0 and the shot length', () => {
    render(<InsertStationDialog />);
    fireEvent.change(screen.getByTestId('insert-station-distance'), { target: { value: '4' } });
    expect(screen.getByTestId('insert-station-confirm')).not.toBeDisabled();
  });

  it('splits, selects the new station, and closes on success', async () => {
    splitShotAtDistance.mockResolvedValue({ success: true, error: null } as CommandResult);

    render(<InsertStationDialog />);
    fireEvent.change(screen.getByTestId('insert-station-distance'), { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('insert-station-confirm'));

    await waitFor(() => expect(closeDialog).toHaveBeenCalled());
    expect(splitShotAtDistance).toHaveBeenCalledWith(SECTION_ID, SHOT_ID, 4);
    expect(setSelection).toHaveBeenCalledWith({
      type: 'station',
      stationRef: { section_id: SECTION_ID, station_index: 1 },
    });
  });

  it('surfaces the backend error and does not close/select on refusal', async () => {
    splitShotAtDistance.mockResolvedValue({
      success: false,
      error: 'Cannot edit geometry of a frozen shot.',
    } as CommandResult);

    render(<InsertStationDialog />);
    fireEvent.change(screen.getByTestId('insert-station-distance'), { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('insert-station-confirm'));

    expect(await screen.findByText('Cannot edit geometry of a frozen shot.')).toBeInTheDocument();
    expect(closeDialog).not.toHaveBeenCalled();
    expect(setSelection).not.toHaveBeenCalled();
  });
});
