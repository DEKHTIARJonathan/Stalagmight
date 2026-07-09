/**
 * tool-switch-spam: rapidly cycle the active tool through every ToolType and
 * verify each switch actually takes (uiStore.activeTool reflects it). Catches
 * tool state desync and handler errors on repeated switching. Restores 'select'
 * at the end.
 */
import type { Scenario } from './framework';
import { ensureProjectLoaded } from './common';

const TOOLS = [
  'select',
  'pan',
  'zoom',
  'merge',
  'measure',
  'move_station',
  'move_segment',
  'move_shot',
  'comment',
  'move_comment',
] as const;

export const toolSwitchSpam: Scenario = {
  name: 'tool-switch-spam',
  description: 'Cycle every ToolType repeatedly; assert activeTool tracks each switch.',
  defaultIterations: 100,
  async run(ctx, { iterations }) {
    await ensureProjectLoaded(ctx);

    for (let i = 0; i < iterations; i++) {
      const tool = TOOLS[i % TOOLS.length];
      const active = await ctx.eval<string>(
        `
        const ui = window.__E2E_TEST__.uiStore.getState();
        ui.setActiveTool(args[0]);
        return window.__E2E_TEST__.uiStore.getState().activeTool;
      `,
        [tool],
      );
      ctx.metric('switches');
      if (active !== tool) throw new Error(`setActiveTool(${tool}) left activeTool=${active}`);
    }

    await ctx.callAction('ui', 'setActiveTool', ['select']);
    ctx.log(`${iterations} tool switches, all tracked`);
  },
};
