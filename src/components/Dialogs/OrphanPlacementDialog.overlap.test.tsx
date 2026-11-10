/**
 * Component test (#681) - OrphanPlacementDialog resolves the WHOLE repeat, one
 * choice per repeated shot.
 *
 * Synthetic layout: the existing "Mainline" (section 2) has 5 shots; the new
 * "Orphan" (section 1) starts with two shots repeating Mainline shots 4 and 5
 * (indices 3, 4), then carries on. The repeat ends at Orphan stn 2 = Mainline
 * stn 5.
 *
 * INJECTION (tried), each seen red with the fix removed:
 * - default merge back to `preferredMergeOffset` (mid-overlap, offset 1): reds
 *   "defaults the connection to the end of the repeat";
 * - filtering the pairs through the old `computeActionableIds(..., mergeImport)`
 *   trimming rule in `applyOverlapChoices`: reds "merging mid-overlap still
 *   resolves every repeated shot" (shot 1 stays Normal - the #681 bug);
 * - passing `replaceDisabled={false}` to the table: reds the doubly-anchored case
 *   (Use new / Average become clickable). Dropping only the `effectiveChoices`
 *   coercion stays green - the disabled controls already block the choice, so
 *   that coercion is a second line of defence, not separately observable here;
 * - `Math.round(score * 100)` instead of `scorePercent`: reds "never shows a
 *   score above 100%".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./SectionPreview', () => ({ default: () => null }));
vi.mock('../../utils/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/telemetry')>()),
  trackDialogComplete: vi.fn(),
}));
// jsdom does not implement scrollIntoView; the Select component calls it on open.
Element.prototype.scrollIntoView = vi.fn();

import OrphanPlacementDialog from './OrphanPlacementDialog';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { CommandResult, OrphanPlacementSuggestion } from '../../types/commands';
import type { Project } from '../../types/ipc/Project';
import type { Shot } from '../../types/ipc/Shot';

const ok = async (): Promise<CommandResult> => ({ success: true } as CommandResult);

function shot(id: number, azimuth: number, length: number, depthIn: number, depthOut: number): Shot {
  return {
    id,
    azimuth_in: azimuth,
    azimuth_out: azimuth,
    length,
    depth_in: depthIn,
    depth_out: depthOut,
    pitch_in: null,
    pitch_out: null,
    left: 1,
    right: 1,
    up: 1,
    down: 1,
    comment: null,
    kind: 'Normal',
    marker_index: null,
    temperature: null,
  };
}

// Mainline shot ids 200..204; Orphan shot ids 100..103.
const MAINLINE = [
  shot(200, 10, 5, 0, 1),
  shot(201, 20, 5, 1, 2),
  shot(202, 30, 5, 2, 3),
  shot(203, 40, 6, 3, 4),
  shot(204, 50, 7, 4, 5),
];
const ORPHAN = [
  shot(100, 40, 6, 3, 4), // identical repeat of Mainline 203
  shot(101, 52, 7.5, 4, 5), // repeat of Mainline 204, re-measured: 2 deg and 0.5 m off
  shot(102, 90, 4, 5, 5),
  shot(103, 95, 4, 5, 6),
];

function makeProject(over: Partial<Project> = {}): Project {
  const section = (id: number, name: string, shots: Shot[]) =>
    ({ id, name, shots, direction: 'in', color: '#4a9eff' }) as unknown as Project['sections'][number];
  return {
    sections: [section(1, 'Orphan', ORPHAN), section(2, 'Mainline', MAINLINE)],
    station_merges: [],
    zero_datums: [],
    loop_closures: [],
    ...over,
  } as unknown as Project;
}

function makeSuggestion(over: Partial<OrphanPlacementSuggestion> = {}): OrphanPlacementSuggestion {
  return {
    orphanSectionId: 1,
    orphanSectionName: 'Orphan',
    orphanStationIndex: 0,
    targetSectionId: 2,
    targetSectionName: 'Mainline',
    targetStationIndex: 3,
    score: 0.9,
    matchedShots: 2,
    existingMatchedShots: 2,
    // What the matcher really prefers for a 2-shot repeat: the mid station.
    preferredMergeOffset: 1,
    direction: 'forward',
    isPartial: false,
    confidence: 'high',
    ...over,
  };
}

async function pickOption(testId: string, value: string) {
  await userEvent.click(screen.getByTestId(testId));
  await userEvent.click(screen.getByTestId(`${testId}-option-${encodeURIComponent(value)}`));
}

let mergeStations: ReturnType<typeof vi.fn>;
let updateShot: ReturnType<typeof vi.fn>;
let setShotKind: ReturnType<typeof vi.fn>;
let closeDialog: ReturnType<typeof vi.fn>;

function setup(project: Project = makeProject()) {
  useProjectStore.setState({ project });
}

async function acceptAndFinish() {
  await userEvent.click(screen.getByTestId('orphan-accept'));
  await waitFor(() => expect(closeDialog).toHaveBeenCalled());
}

const referenceCalls = () =>
  setShotKind.mock.calls.filter((c) => c[2] === 'Reference').map((c) => [c[0], c[1]]);

beforeEach(() => {
  mergeStations = vi.fn(ok);
  updateShot = vi.fn(ok);
  setShotKind = vi.fn(ok);
  closeDialog = vi.fn();
  useProjectStore.setState({
    project: null,
    config: null,
    mergeStations,
    updateShot,
    setShotKind,
    refreshProjectState: vi.fn(async () => {}),
    saveAfterImport: vi.fn(async () => true),
  });
  useUIStore.setState({ closeDialog, setView: vi.fn(), triggerFitToBounds: vi.fn() });
});

describe('OrphanPlacementDialog - repeated shots table (#681)', () => {
  it('renders one row per repeated shot with both readings and the difference', () => {
    setup();
    render(<OrphanPlacementDialog suggestions={[makeSuggestion()]} />);

    const row0 = screen.getByTestId('overlap-row-0');
    const row1 = screen.getByTestId('overlap-row-1');
    expect(screen.queryByTestId('overlap-row-2')).toBeNull();
    expect(screen.queryByTestId('overlap-mode-select')).toBeNull();

    expect(within(row0).getByText('Existing 2:4')).toBeTruthy();
    expect(within(row0).getByText('New 1:1')).toBeTruthy();
    expect(row0.getAttribute('data-differs')).toBe('false');

    expect(within(row1).getByText('Existing 2:5')).toBeTruthy();
    expect(within(row1).getByText('7.5')).toBeTruthy(); // new length
    expect(within(row1).getByText('0.5')).toBeTruthy(); // length difference
    expect(within(row1).getByText('2.0')).toBeTruthy(); // azimuth difference
    expect(row1.getAttribute('data-differs')).toBe('true');
  });

  it('defaults the connection to the end of the repeat', async () => {
    setup();
    render(<OrphanPlacementDialog suggestions={[makeSuggestion()]} />);

    await acceptAndFinish();

    expect(mergeStations).toHaveBeenCalledWith(
      { section_id: 1, station_index: 2 },
      { section_id: 2, station_index: 5 },
    );
  });

  it('defaults every row to Keep existing: the new copies become Reference, nothing is rewritten', async () => {
    setup();
    render(<OrphanPlacementDialog suggestions={[makeSuggestion()]} />);

    await acceptAndFinish();

    expect(referenceCalls()).toEqual([[1, 100], [1, 101]]);
    expect(updateShot).not.toHaveBeenCalled();
  });

  it('merging mid-overlap still resolves every repeated shot', async () => {
    setup();
    render(<OrphanPlacementDialog suggestions={[makeSuggestion()]} />);

    await pickOption('merge-station-select', '1');
    await acceptAndFinish();

    expect(mergeStations).toHaveBeenCalledWith(
      { section_id: 1, station_index: 1 },
      { section_id: 2, station_index: 4 },
    );
    expect(referenceCalls()).toEqual([[1, 100], [1, 101]]);
  });

  it('Use new on one row copies the new reading into the EXISTING shot only for that row', async () => {
    setup();
    render(<OrphanPlacementDialog suggestions={[makeSuggestion()]} />);

    await pickOption('overlap-choice-1', 'use_new');
    await acceptAndFinish();

    expect(referenceCalls()).toEqual([[1, 100], [1, 101]]);
    expect(updateShot).toHaveBeenCalledTimes(1);
    expect(updateShot).toHaveBeenCalledWith(2, 204, expect.objectContaining({
      length: 7.5,
      azimuth_in: 52,
      azimuth_out: 52,
    }));
  });

  it('the bulk control sets every row at once', async () => {
    setup();
    render(<OrphanPlacementDialog suggestions={[makeSuggestion()]} />);

    await userEvent.click(screen.getByTestId('overlap-set-all-average'));
    expect(screen.getByTestId('overlap-set-all-average').getAttribute('aria-pressed')).toBe('true');
    await acceptAndFinish();

    expect(updateShot).toHaveBeenCalledTimes(2);
    expect(updateShot).toHaveBeenCalledWith(2, 203, expect.objectContaining({ length: 6 }));
    expect(updateShot).toHaveBeenCalledWith(2, 204, expect.objectContaining({ length: 7.25 }));
    const az = (updateShot.mock.calls.find((c) => c[1] === 204)![2] as { azimuth_in: number }).azimuth_in;
    expect(az).toBeCloseTo(51);
  });

  it('reverses the new reading when the two surveys run opposite ways (Back + forward)', async () => {
    // The orphan's END repeats Mainline: orphan shots 2, 3 (reversed) are
    // Mainline shots 4, 3. Use new must write them back in Mainline's direction.
    const back = [shot(100, 90, 4, 0, 0), shot(101, 95, 4, 0, 1), shot(102, 230, 7, 5, 4), shot(103, 220, 6, 4, 3)];
    setup(makeProject({
      sections: [
        { id: 1, name: 'Orphan', shots: back, direction: 'in', color: '#4a9eff' },
        { id: 2, name: 'Mainline', shots: MAINLINE, direction: 'in', color: '#4a9eff' },
      ] as unknown as Project['sections'],
    }));
    render(<OrphanPlacementDialog suggestions={[makeSuggestion({ orphanStationIndex: 4, targetStationIndex: 3 })]} />);

    expect(screen.getByTestId('overlap-row-2').getAttribute('data-differs')).toBe('false');
    expect(screen.getByTestId('overlap-row-3').getAttribute('data-differs')).toBe('false');
    await userEvent.click(screen.getByTestId('overlap-set-all-use-new'));
    await acceptAndFinish();

    expect(referenceCalls()).toEqual([[1, 102], [1, 103]]);
    expect(updateShot).toHaveBeenCalledWith(2, 204, expect.objectContaining({ azimuth_in: 50, depth_in: 4, depth_out: 5 }));
    expect(updateShot).toHaveBeenCalledWith(2, 203, expect.objectContaining({ azimuth_in: 40, depth_in: 3, depth_out: 4 }));
  });

  it('a target anchored at both ends allows Keep existing only', async () => {
    const datum = (station_index: number) => ({ station_ref: { section_id: 2, station_index } });
    setup(makeProject({ zero_datums: [datum(0), datum(5)] as unknown as Project['zero_datums'] }));
    render(<OrphanPlacementDialog suggestions={[makeSuggestion()]} />);

    expect((screen.getByTestId('overlap-set-all-use-new') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('overlap-set-all-average') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('overlap-set-all-keep-existing') as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(screen.getByTestId('overlap-choice-1'));
    expect(screen.getByTestId('overlap-choice-1-option-use_new').getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(screen.getByTestId('overlap-choice-1-option-use_new'));
    await acceptAndFinish();

    expect(referenceCalls()).toEqual([[1, 100], [1, 101]]);
    expect(updateShot).not.toHaveBeenCalled();
  });

  it('never shows a score above 100%', () => {
    setup();
    const boosted = makeSuggestion({ score: 1.18 });
    const alternative = makeSuggestion({ score: 1.06, targetStationIndex: 2 });
    render(<OrphanPlacementDialog suggestions={[boosted, alternative]} />);

    expect(screen.getByText('100% score')).toBeTruthy();
    expect(screen.queryByText(/11[0-9]%/)).toBeNull();
  });
});
