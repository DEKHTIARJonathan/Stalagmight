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
