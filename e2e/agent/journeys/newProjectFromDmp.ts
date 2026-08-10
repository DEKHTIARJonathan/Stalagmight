/**
 * new-project-from-dmp: the J1 first-run golden flow (#391/#394 class - the one
 * two expert field testers could not complete). With NO project open, a `.dmp`
 * routed through the app's own file router must carry the user through the
 * new-project-for-import screen and the wizard to a live, SAVED project with a
 * receipt - the deferred-initial-save contract (#92/#104: the first import
 * resolves the reserved save) and the importContext teardown (#477 class)
 * checked at the end.
 *
 * Unlike the other journeys this one drives the real DIALOG UI, not store
 * actions - the flow under test IS the dialog chain. It reuses the import
 * fuzzer's bridge (screen digest + real clicks on testids) but walks a
 * DETERMINISTIC primary path: each screen has exactly one scripted action, and
 * any screen outside the script aborts the journey with the screen name.
 */
import * as fs from 'fs';
import type { Journey, JourneyContext } from './framework';
import { disableAutoSave } from '../scenarios/common';
import {
  injectScreenDigest,
  observeScreen,
  runUiStep,
  routeFile,
  dismissFirstRunModal,
  type Move,
} from '../scenarios/importDialogBridge';
import { oracleInjectionSource } from '../lib/fuzzOracleCore';
import { mapClick } from '../lib/controls';

const DMP_FIXTURE = 'test_v2.dmp';
/** Generous cap: the whole golden path is well under this many screen actions. */
const MAX_STEPS = 40;

interface ParsedDmpShot {
  shot_type: string;
  length: number;
}

interface ParsedDmp {
  sections: { shots: ParsedDmpShot[] }[];
}

/**
 * Mirror of the selection dialog's DEFAULT selection and shot conversion
 * (`src/hooks/useImportState.ts` `isImportableDmpShot`, and
 * `DmpSelectionDialog.tsx`'s initial `selectedIndices`): a shot is importable
 * when it is `Standard` and its length is not the 1.0 excluded-shot sentinel
 * (`DEFAULT_EXCLUDED_DMP_SHOT_LENGTH = 1`); a section is selected by default
 * when it has MORE THAN ONE importable shot. The golden path accepts the
 * defaults, so expectations are derived through this rule. (Duplicate-hash
 * auto-deselection cannot fire here: the project is brand new.)
 */
function defaultSelectionCounts(parsed: ParsedDmp): { sections: number; shots: number } {
  const importable = (s: ParsedDmpShot): boolean =>
    s.shot_type === 'Standard' && Math.abs(s.length - 1) > 1e-9;
  let sections = 0;
  let shots = 0;
  for (const section of parsed.sections) {
    const kept = section.shots.filter(importable).length;
    if (kept <= 1) continue;
    sections += 1;
    shots += kept;
  }
  return { sections, shots };
}

const click = (testid: string): Move => ({ kind: 'ui', testid, label: `click ${testid}` });

/**
 * The scripted primary action per screen. Transient wizard states return null
 * (observe again); a screen missing from this table ends the journey.
 */
function primaryAction(screen: string, live: Record<string, 0 | 1 | 2>): Move | null | 'done' {
  switch (screen) {
    case 'idle':
      return 'done';
    case 'first-run':
      return click('telemetry-opt-in-no');
    case 'new-project':
      return click('create-and-continue-button');
    case 'dmp-select':
      // The golden path ACCEPTS the default selection (see
      // defaultSelectionCounts, which mirrors it) - never click select-all.
      return click('continue-button');
    case 'zero-datum-select':
      return click('zero-datum-selection-skip');
    case 'wiz-suggest':
    case 'wiz-done':
      return live['confirm-button'] === 2 ? click('confirm-button') : null;
    case 'wiz-no-suggest':
      return live['skip-button'] === 2 ? click('skip-button') : null;
    case 'wiz-init':
    case 'wiz-placing':
    case 'wiz-blank':
      return null; // transient - observe again
    case 'orphan-placement':
      return click('orphan-close');
    case 'receipt':
      return click('import-receipt-continue');
    default:
      return 'done'; // caller checks: non-idle here is an abort
  }
}

export const newProjectFromDmp: Journey = {
  name: 'new-project-from-dmp',
  description: 'Route a .dmp with no project open; the dialog chain must end in a saved project.',
  async run(ctx) {
    // The flow under test starts from NOTHING open.
    await ctx.callAction('project', 'closeProject', []).catch(() => undefined);
    await disableAutoSave(ctx);
    const dmp = ctx.fixturePath(DMP_FIXTURE);

    const parsedRes = (await ctx.callAction('project', 'importDmp', [dmp])) as {
      ok: boolean;
      result?: ParsedDmp;
      error?: string;
    };
    if (!parsedRes.ok || !parsedRes.result) {
      throw new Error(`importDmp (parse) failed: ${parsedRes.error ?? 'unknown'}`);
    }
    const { sections: expectedSections, shots: expectedShots } = defaultSelectionCounts(parsedRes.result);
    ctx.expect('fixture parses with default-selected sections', expectedSections > 0,
      `default-selected sections=${expectedSections} shots=${expectedShots}` +
        ` (of ${parsedRes.result.sections.length} parsed)`);

    // The digest's invariant hook reads the fuzz oracle global, so the oracle
    // source goes in first (same order as importDialogFuzz).
    await ctx.eval<boolean>(`${oracleInjectionSource()}\nreturn true;`);
    await injectScreenDigest(ctx);
    await dismissFirstRunModal(ctx);
    const routed = await routeFile(ctx, dmp);
    ctx.expect('file router accepted the .dmp', routed, 'routeOpenedFile hook missing or threw');

    const visited: string[] = [];
    let digest = await observeScreen(ctx);
    for (let step = 0; step < MAX_STEPS; step++) {
      if (digest.screen !== visited[visited.length - 1]) visited.push(digest.screen);
      if (digest.screen === 'idle') break;
      // A WARNING-BEARING receipt is a modal and gets its content checked here.
      // A clean receipt is a TOAST (#456) that expires before a settled digest
      // can see it, so receipt PRESENCE is deliberately not a check - the flow
      // oracles measured that gate as unenforceable (importFlowOracles.ts).
      if (digest.screen === 'receipt' && digest.receipt) {
        ctx.expect('receipt names every imported section',
          digest.receipt.summary.startsWith(`${expectedSections} section`),
          `summary="${digest.receipt.summary}" expected ${expectedSections}`);
        await ctx.checkpoint('receipt');
      }
      if (digest.screen === 'map-placement') {
        // Place at the live map centre, through MapCanvas - the only route
        // that runs the wizard's completion handler (a direct
        // `confirmPlacement()` abandons the flow; see importDialogGenerators).
        const centre = await ctx.eval<[number, number] | null>(`
          const map = window.__stalagmight_map__;
          if (!map || !map.getCenter) return null;
          const c = map.getCenter();
          return [c.lng, c.lat];
        `);
        if (!centre) throw new Error('map-placement with no live map to click');
        await ctx.exclusive(() => mapClick(ctx.browser, centre));
        digest = await observeScreen(ctx);
        continue;
      }
      const action = primaryAction(digest.screen, digest.live);
      if (action === 'done') {
        throw new Error(`unscripted screen "${digest.screen}" (path: ${visited.join(' -> ')})`);
      }
      if (action !== null) {
        const outcome = await runUiStep(ctx, action);
        if (!outcome.performed) {
          throw new Error(
            `"${action.label}" not performed on "${digest.screen}" (${outcome.reason ?? 'unknown'};` +
              ` path: ${visited.join(' -> ')})`,
          );
        }
      } else {
        await ctx.sleep(150);
      }
      digest = await observeScreen(ctx);
    }
    ctx.expect('flow returned to idle within the step budget', digest.screen === 'idle',
      `ended on "${digest.screen}" after path: ${visited.join(' -> ')}`);
    await ctx.checkpoint('after-flow');

    const project = await projectFacts(ctx);
    ctx.expect('a project exists after the flow', project.exists);
    ctx.expect('project carries every default-selected section',
      project.sections === expectedSections,
      `sections=${project.sections} expected=${expectedSections}`);
    ctx.expect('project carries every importable shot of those sections',
      project.shots === expectedShots,
      `shots=${project.shots} expected=${expectedShots}`);
    ctx.expect('deferred initial save resolved to a real file on disk',
      project.filePath !== null && fs.existsSync(project.filePath),
      `file_path=${project.filePath ?? 'null'}`);

    ctx.expect('importContext cleared after completion (the #477 class)',
      digest.ctx === null, `importContext=${String(digest.ctx)}`);
    ctx.expect('no import reads as in-progress at idle', !digest.importInProgress);
  },
};

async function projectFacts(ctx: JourneyContext): Promise<{
  exists: boolean;
  sections: number;
  shots: number;
  filePath: string | null;
}> {
  return ctx.eval(`
    const p = window.__E2E_TEST__.projectStore.getState().project;
    if (!p) return { exists: false, sections: 0, shots: 0, filePath: null };
    return {
      exists: true,
      sections: (p.sections || []).length,
      shots: (p.sections || []).reduce((n, s) => n + ((s.shots || []).length), 0),
      filePath: p.file_path ?? null,
    };
  `);
}
