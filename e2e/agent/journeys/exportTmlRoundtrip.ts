/**
 * export-tml-roundtrip: the release golden flow for TML export (#449 class -
 * "export discards the entire survey"). Export the live project to a temp
 * `.tml`, then parse the exported file back and hold it to the live project's
 * survey content: every section, every shot. The parse-back uses the app's own
 * parser over real IPC, so the journey exercises writer and reader against each
 * other on the real wire.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Journey } from './framework';
import { loadFixtureWithoutUndoHistory, disableAutoSave } from '../scenarios/common';

export const exportTmlRoundtrip: Journey = {
  name: 'export-tml-roundtrip',
  description: 'Export the project to .tml; the exported file must parse back to the same survey.',
  async run(ctx) {
    const { path: fixturePath } = await loadFixtureWithoutUndoHistory(ctx);
    await disableAutoSave(ctx);

    const live = await ctx.eval<{ sections: number; shots: number }>(`
      const p = window.__E2E_TEST__.projectStore.getState().project;
      if (!p) return { sections: 0, shots: 0 };
      const sections = (p.sections || []).length;
      const shots = (p.sections || []).reduce((n, s) => n + ((s.shots || []).length), 0);
      return { sections, shots };
    `);
    ctx.expect('project has survey data to export', live.sections > 0 && live.shots > 0,
      `sections=${live.sections} shots=${live.shots}`);

    const exportPath = path.join(path.dirname(fixturePath), 'journey-export.tml');
    // A reused session dir may hold a stale export; a leftover file must never
    // satisfy the non-empty check for THIS run.
    fs.rmSync(exportPath, { force: true });
    const exported = (await ctx.callAction('project', 'exportTml', [exportPath])) as {
      ok: boolean;
      error?: string;
    };
    ctx.expect('exportTml completed', exported.ok, `error=${exported.error ?? 'unknown'}`);
    await ctx.checkpoint('after-export');

    const stat = fs.existsSync(exportPath) ? fs.statSync(exportPath) : null;
    ctx.expect('exported file exists and is non-empty', (stat?.size ?? 0) > 0,
      `path=${exportPath} size=${stat?.size ?? 'missing'}`);
    if (!stat) return;

    const parsedRes = (await ctx.callAction('project', 'parseTml', [exportPath])) as {
      ok: boolean;
      result?: { sections: { shots: { shot_type: string }[] }[] };
      error?: string;
    };
    ctx.expect('exported file parses back', parsedRes.ok && !!parsedRes.result,
      `error=${parsedRes.error ?? 'unknown'}`);
    if (!parsedRes.result) return;

    // The exporter EMITS synthetic CLOSURE shots for loop closures
    // (export/tml.rs, third pass); they are markers, not survey shots, and the
    // importer filters them right back out. Counting them against live store
    // shots would red this journey on a closure-bearing project despite a
    // lossless export - compare survey shots only.
    const roundSections = parsedRes.result.sections.length;
    const roundShots = parsedRes.result.sections.reduce(
      (n, s) => n + s.shots.filter((shot) => shot.shot_type !== 'Closure').length,
      0,
    );
    ctx.expect('every section survived the round-trip', roundSections === live.sections,
      `exported ${roundSections}, live ${live.sections}`);
    ctx.expect('every shot survived the round-trip', roundShots === live.shots,
      `exported ${roundShots}, live ${live.shots}`);
  },
};
