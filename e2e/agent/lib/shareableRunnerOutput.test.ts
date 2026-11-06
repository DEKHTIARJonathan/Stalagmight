/**
 * #576 W23-NF1..NF3, RV18-W23-4: what the runners print around a verdict is
 * shareable too - the lines a matrix keeps of a cell that died, a harness
 * crash, the progress lines a scenario prints, and the paths in kept lines.
 * Codes, counts and code locations only; the app's text stays out.
 *
 * Everything here is synthetic: token names (`qz...`) stand in for a user, a
 * station and a project.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { foldLocalPaths, shareableFailureText } from './shareableFailure';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const HOME = '/home/qzbob';
const SESSION = `${REPO}/.agent-artifacts/sessions/s1`;
/** The synthetic user, project, section and station a leak would show. */
const names = (text: string): string[] =>
  ['qzbob', 'qzproject', 'qzsection', 'qzstation'].filter((name) => text.includes(name));

let savedHome: string | undefined;
beforeEach(() => {
  savedHome = process.env.HOME;
  process.env.HOME = HOME;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

describe('kept lines carry no local path or name (#576 RV18-W23-4)', () => {
  it('folds the home directory and the checkout out of the headline and every kept line', () => {
    const shared = shareableFailureText(
      [
        `generated file path "g/a.dat" escapes ${SESSION}`,
        `  reproduce: STALAGMIGHT_FUZZ_FIXTURE=${HOME}/fixtures/qzfixture.stalx pnpm agent:scenario s --seed 3` +
          ` (REPLAY of ${SESSION}/traces/t.json)`,
        `  trace: ${SESSION}/traces/t.json`,
      ].join('\n'),
    );
    expect(shared.split('\n')).toEqual([
      'generated file path "g/a.dat" escapes <repo>/.agent-artifacts/sessions/s1',
      '  reproduce: STALAGMIGHT_FUZZ_FIXTURE=~/fixtures/qzfixture.stalx pnpm agent:scenario s --seed 3' +
        ' (REPLAY of <repo>/.agent-artifacts/sessions/s1/traces/t.json)',
      '  trace: <repo>/.agent-artifacts/sessions/s1/traces/t.json',
    ]);
    expect(shared).not.toContain('qzbob');
    expect(shared).not.toContain(REPO);
  });

  it('folds a root only where it ends, never a longer name that starts with it', () => {
    expect(foldLocalPaths(`${HOME}/a ${HOME}by/b ${HOME}`)).toBe(`~/a ${HOME}by/b ~`);
  });

  it('keeps a move-tail heading only in the words the harness writes', () => {
    const shared = shareableFailureText(
      ['U3 undo diff', '  last 3 moves into qzstation:', '  m1', '  last 2 action(s) this iteration:', '  a1'].join(
        '\n',
      ),
    );
    expect(shared).not.toContain('qzstation');
    expect(shared).toContain('  last 2 action(s) this iteration:');
  });

  it("withholds the page's message after a WebDriver `javascript error:`", () => {
    const message = 'Station "qzstation" vanished';
    expect(shareableFailureText(`javascript error: ${message}`)).toBe(
      `javascript error: (${message.length} characters of the app's text withheld)`,
    );
  });
});

/** An error thrown in session setup, as `page.ts` rethrows an IPC rejection. */
function setupCrash(): Error {
  const err = new Error('ipc load_project: section "qzsection" of qzproject is locked\nholder: qzbob');
  err.stack =
    `Error: ${err.message}\n` +
    `    at ipc (${REPO}/e2e/agent/lib/page.ts:120:11)\n` +
    `    at async AppSession.start (file://${REPO}/e2e/agent/session.ts:301:7)\n` +
    '    at Array.map (<anonymous>)\n' +
    '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)';
  return err;
}

describe('a harness crash prints codes, counts and code locations (#576 W23-NF2)', () => {
  it('keeps the name, the headline prefix and the frames, and withholds the app text', async () => {
    const { shareableErrorText } = await import('./shareableFailure');
    const shared = shareableErrorText(setupCrash());
    const appText = 'section "qzsection" of qzproject is locked';
    expect(shared.split('\n')).toEqual([
      `Error: ipc load_project: (${appText.length} characters of the app's text withheld)`,
      "  (1 line(s) withheld: they can quote the app's text - the rest of the error is not printed)",
      '    at ipc (<repo>/e2e/agent/lib/page.ts:120:11)',
      '    at async AppSession.start (file://<repo>/e2e/agent/session.ts:301:7)',
      '    at Array.map (<anonymous>)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
    ]);
    expect(names(shared)).toEqual([]);
  });

  it('projects a thrown non-Error value like a failure message', async () => {
    const { shareableErrorText } = await import('./shareableFailure');
    expect(names(shareableErrorText('ipc save_project: qzproject\nqzbob'))).toEqual([]);
  });

  it('is what every runner prints after `fatal: ` and `shrink failed: `', () => {
    // The runners call `main()` at module scope, so their crash lines are
    // checked in the source: each prints the shareable form, none a raw stack.
    for (const runner of ['scenario-run.ts', 'scenarios-smoke.ts', 'journeys-run.ts', 'fuzz-matrix.ts', 'fuzz-shrink.ts']) {
      const source = fs.readFileSync(path.join(REPO, 'e2e/agent', runner), 'utf8');
      const crashLines = source.split('\n').filter((line) => /`(?:fatal|shrink failed): /.test(line));
      expect(crashLines.length, runner).toBeGreaterThan(0);
      for (const line of crashLines) expect(line, runner).toContain('${shareableErrorText(err)}');
      expect(source, runner).not.toMatch(/err\.stack/);
    }
  });
});
