/**
 * The fuzzable-action allowlist, from both directions.
 *
 * `runStep` dispatches by NAME (`store.getState()[req.action]`), and on a
 * replay that name comes out of a trace file. The allowlist is what stops a
 * crafted trace calling `loadProject` or `saveProject` on a path of its
 * choosing inside a privileged webview - and it is only useful if it also
 * COVERS everything the generators legitimately produce, or the first honest
 * repro of a newly added action dies at the boundary instead of reproducing.
 *
 * Reading the generator sources rather than importing them is deliberate:
 * `undoRedoFuzzActions.ts` and `undoPersistenceCoverage.ts` build their actions
 * inside closures that need a live `ScenarioContext`, so the names cannot be
 * enumerated by calling them. The regex is anchored to the `action: '...'`
 * literal both files use for every generator.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { FUZZABLE_ACTIONS } from '../scenarios/undoRedoFuzzBridge';

const scenariosDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scenarios');

function actionLiteralsIn(file: string): string[] {
  const source = fs.readFileSync(path.join(scenariosDir, file), 'utf8');
  return [...source.matchAll(/\baction: '([A-Za-z][A-Za-z0-9]*)'/g)].map((match) => match[1] ?? '');
}

describe('FUZZABLE_ACTIONS', () => {
  it('covers every action the random generators can produce', () => {
    const produced = actionLiteralsIn('undoRedoFuzzActions.ts');

    expect(produced.length).toBeGreaterThan(15);
    expect(produced.filter((action) => !FUZZABLE_ACTIONS.has(action))).toEqual([]);
  });

  it('covers every action the persistence coverage plan can produce', () => {
    const produced = actionLiteralsIn('undoPersistenceCoverage.ts');

    expect(produced.length).toBeGreaterThan(10);
    expect(produced.filter((action) => !FUZZABLE_ACTIONS.has(action))).toEqual([]);
  });

  it('does NOT carry the store actions a trace must never reach', () => {
    // The three that make a hostile trace worth writing: open a project of its
    // choosing, write over a file of its choosing, or drop the one under test.
    for (const forbidden of ['loadProject', 'closeProject', 'setConfig', 'saveProjectAs']) {
      expect(FUZZABLE_ACTIONS.has(forbidden)).toBe(false);
    }
  });

  it('carries the non-mutation steps the scenarios drive', () => {
    for (const required of ['noop:observe', 'undo', 'redo', 'undoTo', 'redoTo', 'saveProject']) {
      expect(FUZZABLE_ACTIONS.has(required)).toBe(true);
    }
  });
});
