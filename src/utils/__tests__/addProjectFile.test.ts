/**
 * #674: the post-add sequence reuses the existing import tail - dirty via
 * saveAfterImport, orphan placement keyed on `section_ids`, receipt via
 * finishImportWithoutOrphanSuggestions.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const invokeIpc = vi.fn();
vi.mock('../ipc', () => ({ invokeIpc: (...a: unknown[]) => invokeIpc(...a), getErrorMessage: (e: unknown) => String(e) }));

const finish = vi.fn();
vi.mock('../saveFeedback', () => ({
  finishImportWithoutOrphanSuggestions: (...a: unknown[]) => finish(...a),
}));

import { runAddProjectFile } from '../addProjectFile';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';

const addProjectFile = vi.fn();
const saveAfterImport = vi.fn();
const receipt = { source_format: 'x', warnings: [], info: [] };

beforeEach(() => {
  vi.clearAllMocks();
  saveAfterImport.mockResolvedValue(true);
  useProjectStore.setState({ addProjectFile, saveAfterImport } as never);
  useUIStore.setState({ activeDialog: null, dialogData: {}, importContext: null });
});

describe('runAddProjectFile', () => {
  it('stops at a failed command: no save, no orphan lookup, context dropped', async () => {
    addProjectFile.mockResolvedValue({ success: false, section_ids: [] });
    await runAddProjectFile('/cave/a.stalx');
    expect(saveAfterImport).not.toHaveBeenCalled();
    expect(invokeIpc).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(useUIStore.getState().importContext).toBeNull();
  });

  it('opens orphan placement with the receipt when suggestions exist for the new section ids', async () => {
    addProjectFile.mockResolvedValue({ success: true, section_ids: [7, 8], import_receipt: receipt });
    invokeIpc.mockResolvedValue([{ orphanSectionId: 7 }]);
    await runAddProjectFile('/cave/a.stalx');
    expect(invokeIpc).toHaveBeenCalledWith(
      'suggest_orphan_placements',
      { newlyImportedSectionIds: [7, 8] },
      expect.anything(),
    );
    expect(useUIStore.getState().activeDialog).toBe('orphan-placement');
    expect(useUIStore.getState().dialogData).toMatchObject({ receipt });
    expect(finish).not.toHaveBeenCalled();
  });

  it('finishes with the receipt when there are no suggestions', async () => {
    addProjectFile.mockResolvedValue({ success: true, section_ids: [7], import_receipt: receipt });
    invokeIpc.mockResolvedValue([]);
    await runAddProjectFile('/cave/a.stalx');
    expect(finish).toHaveBeenCalledWith('add-or-open-project', expect.anything(), [7], receipt);
  });

  it('skips the orphan lookup when the add created no sections', async () => {
    addProjectFile.mockResolvedValue({ success: true, section_ids: [], import_receipt: receipt });
    await runAddProjectFile('/cave/a.stalx');
    expect(invokeIpc).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith('add-or-open-project', expect.anything(), [], receipt);
  });

  it('a failed orphan lookup is non-fatal and still finishes', async () => {
    addProjectFile.mockResolvedValue({ success: true, section_ids: [7], import_receipt: receipt });
    invokeIpc.mockRejectedValue(new Error('boom'));
    await runAddProjectFile('/cave/a.stalx');
    expect(finish).toHaveBeenCalledTimes(1);
  });
});
