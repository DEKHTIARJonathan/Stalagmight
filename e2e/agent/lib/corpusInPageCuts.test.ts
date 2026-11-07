// @vitest-environment jsdom
/**
 * #576 W33-NF3: three more cuts made before the corpus fold.
 *
 * The rule from RV18-W23-6 is fold first, then cut: a cut through a corpus
 * name leaves a stub no fold matches, and its start prints. Three cuts were
 * made where nothing could fold yet:
 * - `element_state` cut each element's text at 500 IN THE PAGE, and the MCP
 *   server folded the stub into the tool answer and the action log;
 * - the import screen digest cut the error dialog's text (and the receipt
 *   summary) at 300 IN THE PAGE, and the S4 failure quoted it into the FAIL
 *   text and the trace;
 * - the import scenario cut a map click's error message at 32 for a metric
 *   key, which the runner's PASS line and the matrix report print unfolded.
 * Now the page sends the whole text and Node folds it, then cuts it.
 *
 * Each case puts a synthetic name across the old cut. The page code runs as
 * shipped, against jsdom; the scenario's two expressions are read out of its
 * source and evaluated, since they live in its closure and have no seam.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'webdriverio';

import { queryElementState } from './controls';
import * as corpus from './fixtureCorpus';
import { receiptClaimFrom } from './importFlowOracles';
import { computeImportScreenDigest, type ImportScreenDigest } from './importScreenDigest';

const MARK = 'qzinpagecut';
const NAME = `${MARK} CaveA north.dmp`;
const TAG = '<corpus #cut01>/file';
corpus.registerCorpusRedactions('cut01', '/tmp/qzw39/fuzz-files/corpus-0', [NAME]);

type TestWindow = Window & { __E2E_TEST__?: Record<string, unknown> };

afterEach(() => {
  delete (window as TestWindow).__E2E_TEST__;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** WebDriver's `executeAsync`, run against this jsdom. */
const browser = {
  executeAsync: (runner: (fnArgs: unknown[], done: (r: unknown) => void) => void, fnArgs: unknown[]) =>
    new Promise((resolve) => runner(fnArgs, resolve)),
} as unknown as Browser;

/** `text` with the name starting `before` characters ahead of position `cut`. */
const across = (cut: number, before: number): string => `${'x'.repeat(cut - before)}${NAME} could not be read`;

/** One element holding `text`, under `testid`. */
function mount(testid: string, text: string): void {
  const el = document.createElement('div');
  el.setAttribute('data-testid', testid);
  el.textContent = text;
  document.body.appendChild(el);
}

/** The `${...}` expression that follows `marker` in the import scenario's source. */
function scenarioExpression(marker: string): string {
  // `__dirname`, not `import.meta.url`: under jsdom the module URL is not a file URL.
  const source = fs.readFileSync(path.resolve(__dirname, '../scenarios/importDialogFuzz.ts'), 'utf8');
  const at = source.indexOf(marker);
  if (at === -1 || source.indexOf(marker, at + 1) !== -1) throw new Error(`expected exactly one ${marker} in importDialogFuzz.ts`);
  const start = at + marker.length;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && depth-- === 0) return source.slice(start, i);
  }
  throw new Error(`no end to the expression after ${marker}`);
}

/** A digest of the screen in this jsdom, every element laid out. */
async function digestOf(): Promise<ImportScreenDigest> {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 10, height: 10 } as DOMRect);
  (window as TestWindow).__E2E_TEST__ = {
    uiStore: { getState: () => ({ activeDialog: null, placementMode: null, dialogData: {} }) },
    projectStore: { getState: () => ({ project: null }) },
  };
  return computeImportScreenDigest({ inventory: [], selects: [] });
}

describe('a cut made before the fold no longer splits a corpus name (#576 W33-NF3)', () => {
  it('element_state: a name across character 500 of an element text', async () => {
    const text = across(500, 6);
    mount('qz-status', text);
    const state = await queryElementState(browser, { testid: 'qz-status' });
    // What the agent and the action log get: the MCP server folds the result (`capFolded`).
    const published = corpus.redactCorpusValue(state) as typeof state;
    expect(published.elements[0]!.text.slice(480)).toBe(`${'x'.repeat(14)}${TAG.slice(0, 6)}`);
    expect(published.elements[0]!.text).toHaveLength(500);
  });

  it('the S4 failure: a name across character 300 of the error dialog text', async () => {
    mount('error-dialog', across(300, 6));
    const digest = await digestOf();
    expect(digest.screen).toBe('error');
    // The detail line as importDialogFuzz.ts writes it, then the fold `fail` applies.
    const expression = scenarioExpression('\\n  error: ${');
    const quoted = corpus.redactCorpusText(
      String(new Function('digest', 'foldThenCut', `return (${expression});`)(digest, corpus.foldThenCut)),
    );
    expect(quoted.slice(280)).toBe(`${'x'.repeat(14)}${TAG.slice(0, 6)}`);
  });

  it('the receipt summary: a name across character 300', async () => {
    mount('import-receipt-dialog', '');
    document.querySelector('[data-testid="import-receipt-dialog"]')!.innerHTML =
      `<ul><li data-testid="import-receipt-summary">${across(300, 6)}</li></ul>`;
    const digest = await digestOf();
    expect(digest.screen).toBe('receipt');
    const quoted = corpus.redactCorpusText(receiptClaimFrom(digest)!.summary);
    expect(quoted.slice(280)).toBe(`${'x'.repeat(14)}${TAG.slice(0, 6)}`);
  });

  it('the mapSkip metric key: a name across character 32 of the error message', () => {
    // `page error at /tmp/w/` is 21 characters: the old cut kept the name's first 11.
    const err = new Error(`page error at /tmp/w/${NAME}`);
    const expression = scenarioExpression('ctx.metric(`mapSkip:${');
    const key = `mapSkip:${String(new Function('err', 'foldThenCut', `return (${expression});`)(err, corpus.foldThenCut))}`;
    expect(key).toBe(`mapSkip:page error at /tmp/w/${TAG.slice(0, 11)}`);
  });
});
