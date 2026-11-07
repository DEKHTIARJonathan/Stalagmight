/**
 * #576 RV19b-P4: which short names the fold takes.
 *
 * A name under three characters is never folded, since a folder named `1`
 * or `A2` (a Walls `.PATH` folder, a Compass survey folder) would fold every
 * `1` or `A2` in every line. That reason holds for ASCII only. The minimum
 * counted UTF-16 units, so a two-character name in another script - a cave
 * name of two CJK characters - was never folded, though nothing ASCII the
 * harness writes can contain it. Such a name now folds; ASCII ones under three
 * characters still do not, nor does one character written decomposed.
 *
 * Everything here is synthetic: token names and a copy directory that is only a
 * string.
 */
import { describe, expect, it } from 'vitest';

import { redactCorpusText, registerCorpusRedactions } from './fixtureCorpus';

/** Two CJK characters (U+6D1E U+7A9F): a whole cave name. */
const CJK = '\u6d1e\u7a9f';
/** One character, which macOS writes decomposed: two code units, one letter. */
const ONE_ACCENTED = 'e\u0301';
const SHORT_ASCII = ['1', 'A2'];

registerCorpusRedactions('shrt1', '', [CJK, ONE_ACCENTED, ...SHORT_ASCII]);

describe('a two-character name in another script folds (#576 RV19b-P4)', () => {
  it('folds a two-character CJK name, as itself and escaped', () => {
    expect(redactCorpusText(`opened ${CJK}/a.srv`)).toBe('opened <corpus #shrt1>/file/a.srv');
    expect(redactCorpusText('opened \\u6d1e\\u7a9f/a.srv')).toBe('opened <corpus #shrt1>/file/a.srv');
  });

  it('leaves ASCII names under three characters, and one decomposed letter, alone', () => {
    const line = `step 1 of A2: caf${ONE_ACCENTED} 12`;
    expect(redactCorpusText(line)).toBe(line);
  });
});
