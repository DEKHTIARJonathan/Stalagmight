/**
 * Add a `.stalx` into the open project (#674) and finish the way every other
 * import into an existing project does: mark dirty via `saveAfterImport`, offer
 * orphan placement for sections the add left unanchored, and surface the
 * receipt. The command's failure is already reported by the store's
 * `executeCommand` (read-only notice or command-failed toast).
 */
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import { invokeIpc } from './ipc';
import { finishImportWithoutOrphanSuggestions } from './saveFeedback';
import type { OrphanPlacementSuggestion } from '../types/ipc/OrphanPlacementSuggestion';

export async function runAddProjectFile(path: string): Promise<void> {
  const ui = useUIStore.getState();
  ui.setImportContext('existing-project');
  const result = await useProjectStore.getState().addProjectFile(path);
  if (!result.success) {
    useUIStore.getState().setImportContext(null);
    return;
  }
  if (!(await useProjectStore.getState().saveAfterImport())) {
    useUIStore.getState().setImportContext(null);
    return;
  }
  const { closeDialog, setView, triggerFitToBounds, openDialog, showToast } = useUIStore.getState();
  const importUi = { closeDialog, setView, triggerFitToBounds, openDialog, showToast };
  const newSectionIds = result.section_ids;
  if (newSectionIds.length > 0) {
    let suggestions: OrphanPlacementSuggestion[] = [];
    try {
      suggestions = await invokeIpc<OrphanPlacementSuggestion[]>(
        'suggest_orphan_placements',
        { newlyImportedSectionIds: newSectionIds },
        { purpose: 'suggest orphan placements after adding a project file' },
      );
    } catch {
      // Non-fatal: proceed without orphan detection
    }
    if (suggestions.length > 0) {
      openDialog('orphan-placement', { suggestions, receipt: result.import_receipt });
      return;
    }
  }
  await finishImportWithoutOrphanSuggestions('add-or-open-project', importUi, newSectionIds, result.import_receipt);
}
