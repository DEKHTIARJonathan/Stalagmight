import type { ToolType } from '../store/uiStore';

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

/**
 * Tools that never mutate survey geometry (safe in the read-only
 * closure-adjusted view). Everything else (merge, move_*, comment,
 * move_comment) edits the underlying measured data and is disabled
 * while the closure-adjusted view is active.
 */
export const READ_ONLY_TOOLS: ToolType[] = ['select', 'pan', 'zoom', 'measure'];

/** Whether a tool mutates geometry and must be disabled in the adjusted view. */
export function isMutatingTool(tool: ToolType): boolean {
  return !READ_ONLY_TOOLS.includes(tool);
}
