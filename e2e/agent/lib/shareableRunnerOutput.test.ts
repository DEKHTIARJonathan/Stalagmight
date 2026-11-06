/**
 * #576 W23-NF1..NF3, RV18-W23-4: what the runners print around a verdict is
 * shareable too - the lines a matrix keeps of a cell that died, a harness
 * crash, the progress lines a scenario prints, and the paths in kept lines.
 * Codes, counts and code locations only; the app's text stays out.
 *
 * Everything here is synthetic: token names (`qz...`) stand in for a user, a
 * station and a project.
 */
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { foldLocalPaths, shareableFailureText } from './shareableFailure';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const HOME = '/home/qzbob';
const SESSION = `${REPO}/.agent-artifacts/sessions/s1`;

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
