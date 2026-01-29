import type { ToolType } from '../store/uiStore';

export interface ToolGroupDef {
  id: string;
  tools: ToolType[];
  defaultTool: ToolType;
}

export const TOOL_GROUPS: ToolGroupDef[] = [
  { id: 'navigate', tools: ['pan', 'zoom'], defaultTool: 'pan' },
  { id: 'move', tools: ['move_segment', 'move_section', 'move_shot', 'move_station'], defaultTool: 'move_segment' },
];

export function getGroupForTool(tool: ToolType): ToolGroupDef | undefined {
  return TOOL_GROUPS.find((g) => g.tools.includes(tool));
}

export function isGroupedTool(tool: ToolType): boolean {
  return TOOL_GROUPS.some((g) => g.tools.includes(tool));
}

export function getStandaloneTools(): ToolType[] {
  const groupedTools = new Set<ToolType>(TOOL_GROUPS.flatMap((g) => g.tools));
  const allTools: ToolType[] = [
    'select', 'pan', 'zoom', 'draw', 'delete', 'merge', 'measure',
    'move_section', 'move_station', 'move_segment', 'move_shot',
  ];
  return allTools.filter((t) => !groupedTools.has(t));
}
