import type { SectionId, ShotId } from '../types/project';

/**
 * Determines which dialog to open for a Delete Shot action based on the shot's
 * position within its section.
 *
 * - totalShots <= 0: invalid state -> falls through to edge-shot confirm
 * - totalShots === 1: last remaining shot -> confirm delete entire section
 * - mid-section (not first, not last, totalShots >= 3): -> delete-shot-choice dialog
 * - edge shot (first or last): -> simple confirm delete
 *
 * Both the DataTable context menu and the map context menu call this function
 * so they use identical position-aware logic.
 */
export function getDeleteShotDialog(
  sectionId: SectionId,
  shotId: ShotId,
  isFirst: boolean,
  isLast: boolean,
  totalShots: number,
  sectionName: string,
): { dialog: string; data: Record<string, unknown> } {
  if (totalShots === 1) {
    // Last remaining shot: confirm removal of entire section.
    // ConfirmDialog provides the default message for 'last-shot' type.
    return {
      dialog: 'confirm-delete',
      data: {
        type: 'last-shot',
        sectionId,
        shotId,
        sectionName,
      },
    };
  }

  // Mid-section shot requires at least 3 shots (so the shot is truly between
  // first and last). Also guards against invalid state (totalShots <= 0) where
  // isFirst and isLast are both false but there is no real mid-shot.
  const isMidShot = totalShots >= 3 && !isFirst && !isLast;
  if (isMidShot) {
    // Mid-section shot: choose split vs shift geometry
    return {
      dialog: 'delete-shot-choice',
      data: {
        sectionId,
        shotId,
        sectionName,
      },
    };
  }

  // Edge shot (first or last with other shots in section): simple confirm
  return {
    dialog: 'confirm-delete',
    data: {
      type: 'shot',
      sectionId,
      shotId,
      isFirst,
      isLast,
      totalShots,
      sectionName,
    },
  };
}
