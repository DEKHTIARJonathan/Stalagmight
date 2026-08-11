import type { TmlFile, TmlSection, TmlShot } from '../types/commands';

/**
 * The shots the backend will actually import under the current toggles: CLOSURE
 * rows are never imported (they are loop markers, not measurements) and excluded
 * rows only when the user opts in - mirrors `convert_shots_to_shot_data`
 * (src-tauri/src/parsers/tml.rs).
 */
export function importableShots(section: TmlSection, includeExcluded: boolean): TmlShot[] {
  return section.shots.filter(
    (shot) => shot.shot_type !== 'Closure' && (includeExcluded || !shot.excluded)
  );
}

export interface TmlImportStats {
  totalSections: number;
  totalShots: number;
  virtualCount: number;
  totalLength: number;
  depthRange: string | null;
  excludedCount: number;
  commentCount: number;
}

/**
 * Section/shot counts under the given toggles - the single source of truth for
 * every screen that quotes a TML file's size, so the create-project promise and
 * the import dialog's own numbers cannot drift apart (#411).
 *
 * `selected` (#425) narrows every figure to the sections the user kept ticked;
 * `null` - what the pre-dialog screens pass, having no selection to speak of -
 * counts the whole file. Note `excludedCount` and `commentCount` narrow too:
 * they drive the dialog's two option toggles, which are pointless when the only
 * rows they would affect are in sections that are not being imported.
 */
export function computeTmlImportStats(
  tmlFile: TmlFile,
  includeExcluded: boolean,
  selected: ReadonlySet<number> | null = null
): TmlImportStats {
  let totalSections = 0;
  let totalShots = 0;
  let totalLength = 0;
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  let excludedCount = 0;
  let commentCount = 0;
  let virtualCount = 0;

  for (const [index, section] of tmlFile.sections.entries()) {
    if (selected !== null && !selected.has(index)) continue;
    // A section left with no shots by the toggles is dropped by the converter
    // ("no shots after filtering"), so it must not be counted as arriving.
    let sectionShots = 0;
    for (const shot of section.shots) {
      if (shot.shot_type === 'Closure') continue;
      if (shot.excluded) excludedCount++;
      if (!includeExcluded && shot.excluded) continue;
      sectionShots++;
      totalShots++;
      totalLength += shot.length;
      if (shot.depth < minDepth) minDepth = shot.depth;
      if (shot.depth > maxDepth) maxDepth = shot.depth;
      if (shot.comment) commentCount++;
      if (shot.shot_type === 'Virtual') virtualCount++;
    }
    if (sectionShots > 0) totalSections++;
  }

  return {
    totalSections,
    totalShots,
    virtualCount,
    totalLength: Math.round(totalLength * 10) / 10,
    depthRange:
      minDepth === Infinity
        ? null
        : `${Math.round(minDepth * 10) / 10} - ${Math.round(maxDepth * 10) / 10}`,
    excludedCount,
    commentCount,
  };
}
