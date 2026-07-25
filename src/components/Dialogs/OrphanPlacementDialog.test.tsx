/**
 * Component test (#107) - OrphanPlacementDialog completion wiring.
 *
 * This is the bug-prone "completing X must call Y" path behind #92 (data loss):
 * when the orphan-placement step finishes it MUST persist the import via
 * `saveAfterImport`, and on a FAILED save it must keep the dialog open (so the
 * error stays visible) rather than closing as if the import succeeded.
 *
 * The store-level contract of `saveAfterImport` itself is covered by
 * projectStore.saveAfterImport.test.ts; this renders the real dialog and asserts
 * the UI action is actually wired to it - the layer that was previously
 * untestable (no component tier) and shipped #92 on manual verification alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// SectionPreview imports maplibre-gl (WebGL) at module load, which jsdom cannot
// execute. Stub it - this test is about completion wiring, not the preview.
vi.mock('./SectionPreview', () => ({ default: () => null }));
// Telemetry is fire-and-forget; keep it from reaching Tauri IPC under jsdom.
vi.mock('../../utils/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/telemetry')>()),
  trackDialogComplete: vi.fn(),
}));

import OrphanPlacementDialog from './OrphanPlacementDialog';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { CommandResult, OrphanPlacementSuggestion } from '../../types/commands';

const ok = async (): Promise<CommandResult> => ({ success: true } as CommandResult);

/** A minimal, valid suggestion. `matchedShots: 0` skips the shot-rewrite branch
 *  (applyOverlapTreatment returns early), keeping the test focused on the
 *  accept → persist → close wiring. */
function makeSuggestion(over: Partial<OrphanPlacementSuggestion> = {}): OrphanPlacementSuggestion {
  return {
    orphanSectionId: 1,
    orphanSectionName: 'Orphan',
    orphanStationIndex: 0,
    targetSectionId: 2,
    targetSectionName: 'Mainline',
    targetStationIndex: 1,
    score: 0.9,
    matchedShots: 0,
    existingMatchedShots: 0,
    preferredMergeOffset: 0,
    direction: 'forward',
    isPartial: false,
    confidence: 'high',
    ...over,
  };
}

let saveAfterImport: ReturnType<typeof vi.fn>;
let closeDialog: ReturnType<typeof vi.fn>;
let refreshProjectState: ReturnType<typeof vi.fn>;

beforeEach(() => {
  saveAfterImport = vi.fn(async () => true);
  closeDialog = vi.fn();
  refreshProjectState = vi.fn(async () => {});
  // Override every store method the dialog touches so nothing reaches real IPC.
  // No afterEach restore: vitest isolates module state per file and beforeEach
  // re-seeds, so a trailing finish() (the dialog can call it twice) always hits
  // a mock rather than a restored real method mid-unmount.
  useProjectStore.setState({
    project: null,
    mergeStations: vi.fn(ok),
    updateShot: vi.fn(ok),
    setShotReference: vi.fn(ok),
    refreshProjectState,
    saveAfterImport,
  });
  useUIStore.setState({
    closeDialog,
    setView: vi.fn(),
    triggerFitToBounds: vi.fn(),
  });
});

describe('OrphanPlacementDialog - completion persists the import (#92 / #107)', () => {
  it('accepting the last suggestion saves and closes the dialog', async () => {
    render(<OrphanPlacementDialog suggestions={[makeSuggestion()]} />);

    await userEvent.click(screen.getByTestId('orphan-accept'));

    // closeDialog is finish()'s terminal step - waiting for it guarantees the
    // whole chain ran (refresh → save → close), avoiding a race where we assert
    // before the awaited save resolves. (finish() can run twice - from
    // handleAccept and the isFinished effect - so assert "called", not a count.)
    await waitFor(() => expect(closeDialog).toHaveBeenCalled());
    expect(refreshProjectState).toHaveBeenCalled();
    expect(saveAfterImport).toHaveBeenCalled();
  });

  it('keeps the dialog open when the save fails - no phantom success (#92)', async () => {
    saveAfterImport.mockResolvedValue(false);

    render(<OrphanPlacementDialog suggestions={[makeSuggestion()]} />);

    await userEvent.click(screen.getByTestId('orphan-accept'));

    await waitFor(() => expect(saveAfterImport).toHaveBeenCalled());
    // saveAfterImport resolved false. Flush a full macrotask so finish()'s
    // post-await continuation runs to completion - a regression that closed the
    // dialog *after* awaiting the failed save would fire here and be caught,
    // rather than racing past this assertion.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The save failed, so the dialog must NOT close (the error dialog raised by
    // saveAfterImport stays visible instead of being dismissed).
    expect(closeDialog).not.toHaveBeenCalled();
  });
});
