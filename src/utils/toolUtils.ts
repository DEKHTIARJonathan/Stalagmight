import type { ToolType } from '../store/uiStore';
import type { StationRef, SectionId, ShotId } from '../types/project';

/**
 * Tools that should not allow feature interactions (clicks, hovers, context menus).
 * When these tools are active, users should only be able to perform the tool's
 * primary action (pan/zoom) without accidentally selecting or interacting with features.
 */
export const NON_INTERACTIVE_TOOLS: ToolType[] = ['pan', 'zoom'];

/**
 * Check if a tool is non-interactive (should disable feature interactions).
 */
export function isNonInteractiveTool(tool: ToolType): boolean {
  return NON_INTERACTIVE_TOOLS.includes(tool);
}

export interface MoveCommentSource {
  type: 'station' | 'shot';
  stationRef?: StationRef;
  sectionId?: SectionId;
  shotId?: ShotId;
  comment: string;
  /** Screen position of the click that picked up the comment (for cursor tag) */
  screenPos?: { x: number; y: number };
}

/**
 * Restore a picked-up comment back to its source.
 * Called when cancelling a move (Escape, empty click, tool switch).
 * Uses dynamic import to avoid circular dependency (toolUtils → projectStore → uiStore → toolUtils).
 */
export async function restoreMoveCommentSource(source: MoveCommentSource | null): Promise<void> {
  if (!source) return;
  const { useProjectStore } = await import('../store/projectStore');
  const ps = useProjectStore.getState();
  if (source.type === 'station' && source.stationRef) {
    await ps.updateStationComment(source.stationRef, source.comment);
  } else if (source.type === 'shot' && source.sectionId !== undefined && source.shotId !== undefined) {
    await ps.updateShot(source.sectionId, source.shotId, { comment: source.comment });
  }
}
