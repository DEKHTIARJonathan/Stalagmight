/**
 * import-repeatedly: import the same .tml into the project many times and assert
 * the undo stack stays capped at its FIFO limit (docs/undo-redo.md: history_limit
 * default 100). Catches unbounded undo-stack growth / memory creep on repeated
 * imports.
 */
import * as fs from 'fs';
import type { Scenario } from './framework';
import { ensureProjectLoaded, fixturePath, undoDepth } from './common';

const UNDO_LIMIT = 100;
const TML_FIXTURE = 'test_simple.tml';

export const importRepeatedly: Scenario = {
  name: 'import-repeatedly',
  description: 'Import a .tml repeatedly; assert the undo stack stays <= its FIFO cap.',
  defaultIterations: 20,
  async run(ctx, { iterations }) {
    await ensureProjectLoaded(ctx);
    const tml = fixturePath(TML_FIXTURE);
    if (!fs.existsSync(tml)) throw new Error(`fixture missing: ${tml}`);

    const hashRes = (await ctx.callAction('project', 'calculateFileHash', [tml])) as {
      ok: boolean;
      result?: string;
    };
    const hash = hashRes.ok ? hashRes.result : null;

    for (let i = 0; i < iterations; i++) {
      const res = (await ctx.callAction('project', 'executeTmlImport', [tml, hash, false])) as {
        ok: boolean;
        result?: { success?: boolean; error?: string };
      };
      if (!res.ok || res.result?.success === false) {
        throw new Error(`tml import ${i} failed: ${res.result?.error ?? 'unknown'}`);
      }
      ctx.metric('imports');

      const depth = await undoDepth(ctx);
      if (depth > UNDO_LIMIT) {
        throw new Error(`undo stack grew to ${depth}, exceeding the ${UNDO_LIMIT} FIFO cap`);
      }
    }

    const finalDepth = await undoDepth(ctx);
    ctx.setMetric('finalUndoDepth', finalDepth);
    ctx.log(`${iterations} imports; final undo depth ${finalDepth} (cap ${UNDO_LIMIT})`);
  },
};
