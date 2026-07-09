/**
 * rapid-project-cycle: open then close a fixture project many times, asserting a
 * clean open (project non-null) and a clean close (project null) each cycle.
 * Catches lock/handle leaks and teardown races in the open/close path (each call
 * is awaited, per closeProject's isClosing guard).
 */
import * as fs from 'fs';
import type { Scenario } from './framework';
import { fixturePath, DEFAULT_FIXTURE } from './common';

export const rapidProjectCycle: Scenario = {
  name: 'rapid-project-cycle',
  description: 'Open+close a fixture repeatedly; assert clean project null/non-null transitions.',
  defaultIterations: 15,
  async run(ctx, { iterations }) {
    const p = fixturePath(DEFAULT_FIXTURE);
    if (!fs.existsSync(p)) throw new Error(`fixture missing: ${p}`);

    // Start from a clean slate.
    await ctx.callAction('project', 'closeProject', []);

    for (let i = 0; i < iterations; i++) {
      const opened = (await ctx.callAction('project', 'openProject', [p])) as {
        ok: boolean;
        result?: { success?: boolean; error?: string };
      };
      if (!opened.ok || opened.result?.success === false) {
        throw new Error(`open cycle ${i} failed: ${opened.result?.error ?? 'unknown'}`);
      }
      if (!(await ctx.eval<boolean>('return !!window.__E2E_TEST__.projectStore.getState().project;'))) {
        throw new Error(`project null after open cycle ${i}`);
      }

      const closed = (await ctx.callAction('project', 'closeProject', [])) as {
        ok: boolean;
        result?: { success?: boolean; error?: string };
      };
      if (!closed.ok || closed.result?.success === false) {
        throw new Error(`close cycle ${i} failed: ${closed.result?.error ?? 'unknown'}`);
      }
      if (await ctx.eval<boolean>('return !!window.__E2E_TEST__.projectStore.getState().project;')) {
        throw new Error(`project not null after close cycle ${i}`);
      }
      ctx.metric('cycles');
    }

    await ctx.callAction('ui', 'setView', ['global']);
    ctx.log(`${iterations} open/close cycles, all clean`);
  },
};
