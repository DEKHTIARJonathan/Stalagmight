import type { SectionId, ShotId } from '../types/project';

/**
 * Determines which dialog to open for a Delete Shot action based on the shot's
 * position within its section.
 *
 * - totalShots === 1: last remaining shot -> confirm delete entire section
 * - mid-section (not first, not last): -> split-section dialog
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
    // Last remaining shot: confirm removal of entire section
    return {
      dialog: 'confirm-delete',
      data: {
        type: 'last-shot',
        sectionId,
        shotId,
        sectionName,
        message:
          'This is the only shot in the section. Deleting it will remove the entire section. Continue?',
      },
    };
  }

  const isMidShot = !isFirst && !isLast;
  if (isMidShot) {
    // Mid-section shot: open split-section dialog
    return {
      dialog: 'split-section',
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
