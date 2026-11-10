/**
 * Applying one orphan-placement suggestion (#681): join the orphan at the merge
 * station, then resolve the shots it repeats, all through the undoable,
 * edit-gated store actions. Kept out of OrphanPlacementDialog so the dialog
 * holds the UI and this holds what Accept and Accept All do to the project.
 */

import type { OrphanPlacementSuggestion } from '../types/commands';
import type { Project } from '../types/ipc/Project';
import type { ProjectStore } from '../store/projectStore';
import { computeMergeOptions, type MergeOption, type OverlapParams } from './overlapHelpers';
import { repeatedShots, resolvedReading, type OverlapChoice } from './overlapChoices';

/** The overlap geometry of a suggestion, as the overlap helpers take it. */
export function overlapParamsOf(s: OrphanPlacementSuggestion): OverlapParams {
  return {
    importStationIndex: s.orphanStationIndex,
    matchedShots: s.matchedShots,
    existingMatchedShots: s.existingMatchedShots,
    existingStationIndex: s.targetStationIndex,
    direction: s.direction,
  };
}

/** The merge stations a suggestion offers; the last is the end of the repeat. */
export function mergeOptionsOf(s: OrphanPlacementSuggestion, orphanShotCount: number): MergeOption[] {
  return computeMergeOptions(
    {
      importStationIndex: s.orphanStationIndex,
      existingStationIndex: s.targetStationIndex,
      matchedShots: s.matchedShots,
      existingMatchedShots: s.existingMatchedShots,
      preferredMergeOffset: s.preferredMergeOffset,
      direction: s.direction,
      isPartial: s.isPartial,
    },
    orphanShotCount,
  );
}

/** The store actions a placement runs, and the project as it stands now. */
export interface PlacementActions {
  mergeStations: ProjectStore['mergeStations'];
  setShotKind: ProjectStore['setShotKind'];
  updateShot: ProjectStore['updateShot'];
  project: () => Project | null;
}

/**
 * Join `suggestion` at `mergePair` and resolve its repeat: the repeated shots up
 * to the merge station, the ones the dialog's table lists. Each new copy becomes
 * a Reference shot - kept, never deleted. For Use new and Average the EXISTING
 * shot takes the resolved reading, so its stations, connections, closures and
 * comments stay where they are.
 */
export async function placeSuggestion(
  suggestion: OrphanPlacementSuggestion,
  mergePair: MergeOption | null,
  choices: ReadonlyMap<number, OverlapChoice>,
  actions: PlacementActions,
): Promise<void> {
  const mergeImport = mergePair?.importStation ?? suggestion.orphanStationIndex;
  const mergeExisting = mergePair?.existingStation ?? suggestion.targetStationIndex;
  await actions.mergeStations(
    { section_id: suggestion.orphanSectionId, station_index: mergeImport },
    { section_id: suggestion.targetSectionId, station_index: mergeExisting },
  );
  if (suggestion.matchedShots === 0) return;

  // Fresh sections: the merge above refreshed the project.
  const proj = actions.project();
  const oSection = proj?.sections.find((s) => s.id === suggestion.orphanSectionId);
  const tSection = proj?.sections.find((s) => s.id === suggestion.targetSectionId);
  if (!oSection || !tSection) return;

  const params = overlapParamsOf(suggestion);
  for (const repeat of repeatedShots(params, mergeImport, oSection.shots, tSection.shots)) {
    await actions.setShotKind(suggestion.orphanSectionId, repeat.orphanShot.id, 'Reference');
    const choice = choices.get(repeat.orphanShotIndex) ?? 'keep_existing';
    const reading = resolvedReading(choice, repeat.targetShot, repeat.incoming);
    if (reading) {
      await actions.updateShot(suggestion.targetSectionId, repeat.targetShot.id, reading);
    }
  }
}
