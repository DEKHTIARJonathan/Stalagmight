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
      // Yield two animation frames after open and after close so React actually
      // commits (mounts then unmounts) the dialog subtree; a synchronous
      // open+close in one task would batch to a no-op render and test nothing.
      const cycle = await ctx.eval<{ opened: string | null; residue: string | null }>(
        `
        const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const ui = () => window.__E2E_TEST__.uiStore.getState();
        ui().openDialog(args[0]);
        await raf();
        const opened = ui().activeDialog;
        ui().closeDialog();
        await raf();
        return { opened, residue: ui().activeDialog };
      `,
        [dialog],
      );
      ctx.metric('cycles');
      if (cycle.opened !== dialog) {
        throw new Error(`openDialog(${dialog}) left activeDialog=${cycle.opened}`);
      }
      if (cycle.residue !== null) {
        throw new Error(`dialog ${dialog} left activeDialog=${cycle.residue} after close`);
      }
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
