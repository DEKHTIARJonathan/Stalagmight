/**
 * #394: the DMP wizard's two exits vs. the sections it has already imported.
 *
 * The wizard imports EAGERLY - the zero-datum anchor lands in the project from a
 * mount effect, before the user has agreed to anything, because the map has to
 * render it. Both exits used to ignore that:
 *
 * * BACK reopened the previous step and the forward pass re-ran the same mount
 *   effect, so the anchor section was imported a SECOND time (F1).
 * * CANCEL gated its confirmation on `connections.length` - client-side records
 *   that have imported nothing - so cancelling right after the anchor import
 *   closed silently and the project kept the section (F2).
 *
 * The oracle here is a fake project the IPC mock actually mutates: `import_sections`
 * appends ids, `execute_batch` removes the ones its `delete_section` commands name.
 * A test that only counted IPC calls would pass on a withdrawal that deleted the
 * wrong ids.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { DmpFile } from '../../../types/commands';
import type { ImportReceipt } from '../../../types/ipc/ImportReceipt';
import type { DmpSelectionConfig } from '../DmpSelectionDialog';

// SectionPreview and the map panel pull maplibre-gl (WebGL) at module load,
// which jsdom cannot execute. Nothing here asserts on anything drawn.
vi.mock('../SectionPreview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../SectionPreview')>()),
  default: () => null,
}));
vi.mock('maplibre-gl', () => ({ default: {} }));
vi.mock('../WizardMapPanel', () => ({
  WizardMapPanel: () => null,
  MAP_PANEL_DEFAULT_WIDTH: 400,
  MAP_PANEL_MAX_WIDTH: 800,
}));
// Interpolation is kept, not swallowed: "how many sections are at stake" is the
// whole point of the new confirmation copy, so the count has to be observable.
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));
vi.mock('../../../utils/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/telemetry')>()),
  trackDialogComplete: vi.fn(),
  setSource: vi.fn(),
}));

const invokeIpcMock = vi.fn();
vi.mock('../../../utils/ipc', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
  getErrorMessage: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback),
}));

import DmpNewImportDialog, { type SavedManualPlacingState } from '../DmpNewImportDialog';
import type { ZeroDatumConfigResult } from '../ZeroDatumConfigDialog';
import { convertToEditableShots } from '../../../hooks/useImportState';
import { useUIStore } from '../../../store/uiStore';

const receipt = (): ImportReceipt => ({
  source_format: 'mNemo DMP',
  file_name: 'dive.dmp',
  sections_found: 2,
  sections_imported: 1,
  shot_count: 3,
  closures_requested: 0,
  closures_created: 0,
  unit_conversion: null,
  warnings: [],
  info: [],
});

// Fully synthetic, in the real `DmpShot` shape: `shot_type: 'Standard'` and a
// non-unit length are what `isImportableDmpShot` keeps.
const dmpSection = (name: string) => ({
  version: 1,
  name,
  direction: 'in',
  date: '2026-01-01',
  content_hash: `hash_${name}`,
  shots: Array.from({ length: 2 }, () => ({
    shot_type: 'Standard',
    heading_in: 10,
    heading_out: 10,
    length: 5,
    depth_in: 0,
    depth_out: 0,
    pitch_in: 0,
    pitch_out: 0,
    left: 0,
    right: 0,
    up: 0,
    down: 0,
    temperature: 20,
    hour: 12,
    minute: 0,
    second: 0,
    marker_index: 0,
  })),
});

const dmpFile = { version: 1, sections: [dmpSection('A'), dmpSection('B')] } as unknown as DmpFile;

const selectionConfig = (selected: number[]): DmpSelectionConfig => ({
  selectedIndices: new Set(selected),
  defaultSurveyor: 'S',
  defaultDate: null,
  fileHash: null,
  sectionHashes: [],
});

const savedState = (overrides: Partial<SavedManualPlacingState>): SavedManualPlacingState => ({
  connections: [],
  skippedIndices: [],
  segmentQueue: [],
  segmentAnchor: { sectionIndex: 0, stationIndex: 0 },
  directPlacements: [],
  skippedSuggestions: [],
  segmentSkipCounts: [],
  sectionEdits: [],
  ...overrides,
});

/** The single-section case: the zero datum IS the whole import, so the mount
 *  effect imports it and the wizard needs no further input. */
const zeroDatumOnly = (): ZeroDatumConfigResult => ({
  sectionIndex: 0,
  stationIndex: 0,
  gps: { latitude: 20, longitude: -87, depth_reference: 0 },
  metadata: {
    name: 'A',
    surveyor: 'S',
    date: '2026-01-01',
    color: '#ffffff',
    direction: 'in',
    quality: 1,
    reverse: false,
  },
  shots: convertToEditableShots(dmpFile.sections[0]!.shots),
});

/** The fake project: what the wizard has actually put in it, right now. */
let projectSectionIds: number[] = [];
let nextSectionId = 0;
/** Every `execute_batch` payload the wizard sent, so "one undo step" is checkable. */
let batches: Array<Array<{ type: string; section_id?: number }>> = [];

const renderWizard = (
  saved: SavedManualPlacingState | undefined,
  props: {
    onComplete?: (ids?: number[], r?: ImportReceipt) => void;
    onCancel?: () => void;
    onBack?: () => void;
    selected?: number[];
    zeroDatumConfig?: ZeroDatumConfigResult;
  },
) =>
  render(
    <DmpNewImportDialog
      dmpFile={dmpFile}
      selectionConfig={selectionConfig(props.selected ?? [0])}
      project={null}
      stations={[]}
      onCancel={props.onCancel ?? vi.fn()}
      onBack={props.onBack ?? vi.fn()}
      onComplete={props.onComplete ?? vi.fn()}
      savedManualPlacingState={saved}
      zeroDatumConfig={props.zeroDatumConfig}
      autoStartManualPlacement={false}
    />,
  );

describe('DMP wizard: what Back and Cancel do with sections already imported (#394)', () => {
  beforeEach(() => {
    projectSectionIds = [];
    nextSectionId = 7;
    batches = [];
    invokeIpcMock.mockReset();
    invokeIpcMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'import_sections') {
        const configs = (args?.sections as unknown[] | undefined) ?? [];
        const ids = configs.map(() => nextSectionId++);
        projectSectionIds.push(...ids);
        return { success: true, section_ids: ids, import_receipt: receipt(), warnings: [] };
      }
      if (cmd === 'execute_batch') {
        const commands = (args?.commands ?? []) as Array<{ type: string; section_id?: number }>;
        batches.push(commands);
        for (const command of commands) {
          if (command.type === 'delete_section') {
            projectSectionIds = projectSectionIds.filter((id) => id !== command.section_id);
          }
        }
        return { success: true, warnings: [] };
      }
      return null;
    });
    useUIStore.setState({ activeDialog: null, dialogData: {}, placementMode: null });
  });

  /**
   * F1. The wizard cannot "remember it already imported" across Back: the mount
   * effect that imports the anchor is the SAME one that fires
   * `suggest_all_import_placements`, so suppressing it would strand the reopened
   * instance with nothing to do - and it would pin the anchor to the first pass's
   * GPS, which is what the user pressed Back to change. So Back withdraws, and
   * the forward pass imports exactly once more.
   *
   * Injection: drop the `withdrawImportedSections()` call from
   * `handleBackWithRemoval` and the second pass leaves TWO sections behind.
   */
  it('Back withdraws the anchor, so re-confirming the same config leaves one section', async () => {
    const onBack = vi.fn();
    const first = renderWizard(undefined, {
      onBack,
      selected: [0],
      zeroDatumConfig: zeroDatumOnly(),
    });

    await waitFor(() => expect(projectSectionIds).toEqual([7]));

    fireEvent.click(screen.getByTestId('back-button'));
    expect(screen.getByTestId('back-confirm-message')).toHaveTextContent(
      'dialogs.dmpNewImport.backWizardMessage:{"count":1}',
    );

    fireEvent.click(screen.getByTestId('confirm-back-button'));
    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(projectSectionIds).toEqual([]);
    first.unmount();

    // App.tsx reopens `zero-datum-config`; the user confirms the same anchor
    // again and a FRESH wizard instance mounts on it.
    const onComplete = vi.fn();
    renderWizard(undefined, { onComplete, selected: [0], zeroDatumConfig: zeroDatumOnly() });

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(projectSectionIds).toHaveLength(1);
    // #487 residue 1: the withdrawn pass's receipt went with it, so the summary
    // describes ONE import, not two.
    expect(onComplete.mock.calls[0]![1]).toMatchObject({ sections_imported: 1, shot_count: 3 });
  });

  /**
   * F2, first half. The confirmation has to exist at all, and has to say how many
   * sections are at stake - `connections` is empty here, which is exactly the
   * state the old gate read as "nothing to warn about".
   *
   * Injection: restore the gate to `connections.length > 0` and the wizard closes
   * without ever rendering the dialog this queries.
   */
  it('Cancel after the anchor import asks, and names the count', async () => {
    const onCancel = vi.fn();
    renderWizard(undefined, { onCancel, selected: [0], zeroDatumConfig: zeroDatumOnly() });

    await waitFor(() => expect(projectSectionIds).toEqual([7]));

    fireEvent.click(screen.getByTestId('cancel-button'));

    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId('cancel-confirm-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('cancel-confirm-message')).toHaveTextContent(
      'dialogs.dmpNewImport.cancelWizardMessage:{"count":1}',
    );
    expect(screen.getByTestId('cancel-remove-button')).toBeInTheDocument();
  });

  /**
   * F2, second half, on a run that crossed the map-placement handoff: the ids
   * ride `SavedManualPlacingState.importedSectionIds` (#487 residue 2), and the
   * withdrawal is ONE `execute_batch` - one undo entry for one user action.
   * (That a batch of `delete_section` really is one undo entry is pinned in Rust:
   * `batched_section_deletes_are_one_undo_entry`.)
   *
   * Injection: drop `importedSectionIds` from the saved-state seed and the button
   * is not even offered; loop `deleteSection` instead of batching and `batches`
   * holds two one-command payloads.
   */
  it('Remove withdraws the whole run - every carried id, in one batch', async () => {
    projectSectionIds = [7, 8];
    const onCancel = vi.fn();
    const onComplete = vi.fn();
    renderWizard(
      savedState({
        segmentQueue: [[1]],
        segmentAnchor: { sectionIndex: 1, stationIndex: 0 },
        importedSectionIds: [7, 8],
        importedReceipts: [receipt(), receipt()],
      }),
      { onCancel, onComplete, selected: [0, 1] },
    );

    fireEvent.click(screen.getByTestId('cancel-button'));
    expect(screen.getByTestId('cancel-confirm-message')).toHaveTextContent(
      'dialogs.dmpNewImport.cancelWizardMessage:{"count":2}',
    );

    fireEvent.click(screen.getByTestId('cancel-remove-button'));

    await waitFor(() => expect(onCancel).toHaveBeenCalled());
    expect(projectSectionIds).toEqual([]);
    expect(batches).toEqual([
      [
        { type: 'delete_section', section_id: 7 },
        { type: 'delete_section', section_id: 8 },
      ],
    ]);
    // A withdrawn run completes nothing, so nothing is summarised for it either.
    expect(onComplete).not.toHaveBeenCalled();
  });

  /**
   * The other half of the F2 decision: "Keep and close" is still offered, and it
   * is the one exit that leaves the project alone.
   *
   * Injection: wire `confirm-cancel-button` to the withdrawal and the kept
   * section disappears.
   */
  it('Keep and close leaves the imported sections in the project', async () => {
    const onCancel = vi.fn();
    renderWizard(undefined, { onCancel, selected: [0], zeroDatumConfig: zeroDatumOnly() });

    await waitFor(() => expect(projectSectionIds).toEqual([7]));

    fireEvent.click(screen.getByTestId('cancel-button'));
    fireEvent.click(screen.getByTestId('confirm-cancel-button'));

    expect(onCancel).toHaveBeenCalled();
    expect(projectSectionIds).toEqual([7]);
    expect(batches).toEqual([]);
  });

  /**
   * With nothing imported the wizard has nothing to withdraw, so the copy is the
   * plain question - the string that had been unreachable since the gate keyed
   * on `connections.length`, the same field that decided which branch to show.
   *
   * Injection: key the message off `connections.length` again and this renders
   * the count-bearing string with `count: 0`.
   */
  it('offers the plain confirmation when a connection is recorded but nothing is imported', () => {
    const onCancel = vi.fn();
    renderWizard(
      savedState({
        segmentQueue: [[1]],
        segmentAnchor: { sectionIndex: 1, stationIndex: 0 },
        connections: [
          {
            importSectionIndex: 1,
            importStationIndex: 0,
            targetType: 'existing',
            existingSectionId: 3,
            existingStationIndex: 0,
          },
        ],
      }),
      { onCancel, selected: [0, 1] },
    );

    fireEvent.click(screen.getByTestId('cancel-button'));

    expect(screen.getByTestId('cancel-confirm-message')).toHaveTextContent(
      'dialogs.dmpNewImport.cancelWizardNoImports',
    );
    expect(screen.queryByTestId('cancel-remove-button')).not.toBeInTheDocument();
  });
});
