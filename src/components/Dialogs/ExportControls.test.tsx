/**
 * Component test - the TML export "some sections will be discarded" dialog (#411).
 *
 * The defect: exporting a project with zero zero-datums raised a modal listing
 * EVERY section as "potentially discarded" with no way to act on it. The dialog
 * needs to (a) tell the user the actual fix (anchor a station via Set Zero
 * Datum), and (b) distinguish "the whole project has no zero datum" from
 * "some sections just aren't connected to one" - those read very differently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../utils/fileDialogs', () => ({
  saveDialog: vi.fn(),
  exportSaveFilters: vi.fn(() => []),
  ensureExtension: vi.fn((p: string) => p),
}));

import ExportControls from './ExportControls';
import { useProjectStore } from '../../store/projectStore';
import { saveDialog } from '../../utils/fileDialogs';
import { DEFAULT_IMAGE_OPTIONS } from '../../store/exportStore';
import type { Project } from '../../types/ipc/Project';
import type { Section } from '../../types/ipc/Section';
import type { ZeroDatum } from '../../types/ipc/ZeroDatum';

const section = (id: number, name: string | null = null): Section =>
  ({ id, name, shots: [] }) as unknown as Section;

const ZERO_DATUM: ZeroDatum = {
  station_ref: { section_id: 1, station_index: 0 },
  gps: { latitude: 1, longitude: 2, depth_reference: 0 },
};

const buildProject = (sections: Section[], zero_datums: ZeroDatum[]): Project =>
  ({ sections, zero_datums } as unknown as Project);

let getAnchoredSectionIds: ReturnType<typeof vi.fn>;
let exportTml: ReturnType<typeof vi.fn>;

const baseProps = {
  variant: 'dialog' as const,
  exportType: 'data' as const,
  onExportTypeChange: vi.fn(),
  dataFormat: 'tml' as const,
  onDataFormatChange: vi.fn(),
  imageOptions: DEFAULT_IMAGE_OPTIONS,
  onImageOptionsChange: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  getAnchoredSectionIds = vi.fn();
  exportTml = vi.fn(async () => undefined);
  vi.mocked(saveDialog).mockResolvedValue('/tmp/out.tml');
});

describe('TML export unanchored-section warning', () => {
  it('names the fix and says "every section" when the project has no zero datum at all', async () => {
    getAnchoredSectionIds.mockResolvedValue([]);
    useProjectStore.setState({
      project: buildProject([section(1), section(2)], []),
      getAnchoredSectionIds,
      exportTml,
    });

    render(<ExportControls {...baseProps} />);
    await userEvent.click(screen.getByTestId('export-button'));

    const dialog = await screen.findByTestId('tml-unanchored-warning-dialog');
    expect(dialog).toHaveTextContent('This project has no zero datum');
    expect(dialog).toHaveTextContent('Set Zero Datum');
    expect(dialog).not.toHaveTextContent(/\d+ of \d+ sections/);
    expect(saveDialog).not.toHaveBeenCalled();
  });

  it('names the fix and gives a count when only some sections are unanchored', async () => {
    getAnchoredSectionIds.mockResolvedValue([1]);
    useProjectStore.setState({
      project: buildProject([section(1), section(2), section(3)], [ZERO_DATUM]),
      getAnchoredSectionIds,
      exportTml,
    });

    render(<ExportControls {...baseProps} />);
    await userEvent.click(screen.getByTestId('export-button'));

    const dialog = await screen.findByTestId('tml-unanchored-warning-dialog');
    expect(dialog).toHaveTextContent('2 of 3 sections');
    expect(dialog).toHaveTextContent('Set Zero Datum');
    expect(dialog).not.toHaveTextContent('This project has no zero datum');
    expect(saveDialog).not.toHaveBeenCalled();
  });

  it('does not show the dialog when every section is anchored', async () => {
    getAnchoredSectionIds.mockResolvedValue([1, 2]);
    useProjectStore.setState({
      project: buildProject([section(1), section(2)], [ZERO_DATUM]),
      getAnchoredSectionIds,
      exportTml,
    });

    render(<ExportControls {...baseProps} />);
    await userEvent.click(screen.getByTestId('export-button'));

    await waitFor(() => expect(saveDialog).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('tml-unanchored-warning-dialog')).not.toBeInTheDocument();
  });
});
