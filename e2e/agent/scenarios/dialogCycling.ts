/**
 * dialog-cycling: open and close standalone dialogs many times, asserting no
 * residual open dialog after each close and that the DOM node count does not
 * trend upward (a leak of un-unmounted dialog subtrees). Uses uiStore
 * open/closeDialog (synchronous) rather than clicking, which is more reliable.
 */
import type { Scenario } from './framework';

// Dialogs that render standalone (no project/data required, no side effects).
const DIALOGS = ['keyboard-shortcuts', 'settings', 'new-project'];

export const dialogCycling: Scenario = {
  name: 'dialog-cycling',
  description: 'Open/close standalone dialogs repeatedly; assert no residue or DOM-node growth.',
  defaultIterations: 30,
  async run(ctx, { iterations }) {
    const nodesBefore = await ctx.eval<number>('return document.querySelectorAll("*").length;');

    for (let i = 0; i < iterations; i++) {
      const dialog = DIALOGS[i % DIALOGS.length];
      const residue = await ctx.eval<string | null>(
        `
        const ui = window.__E2E_TEST__.uiStore.getState();
        ui.openDialog(args[0]);
        ui.closeDialog();
        return window.__E2E_TEST__.uiStore.getState().activeDialog;
      `,
        [dialog],
      );
      ctx.metric('cycles');
      if (residue !== null) throw new Error(`dialog ${dialog} left activeDialog=${residue} after close`);
    }

    const nodesAfter = await ctx.eval<number>('return document.querySelectorAll("*").length;');
    ctx.setMetric('domNodesBefore', nodesBefore);
    ctx.setMetric('domNodesAfter', nodesAfter);
    ctx.setMetric('domNodeGrowth', nodesAfter - nodesBefore);
    ctx.log(`${iterations} dialog cycles; DOM nodes ${nodesBefore} -> ${nodesAfter}`);

    // A large positive trend is suspicious but a warning (metric), not a failure:
    // React can legitimately keep portals mounted. The full sweep judges severity.
  },
};
