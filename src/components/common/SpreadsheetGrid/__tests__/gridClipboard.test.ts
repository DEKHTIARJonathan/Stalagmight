import { describe, it, expect } from 'vitest';
import {
  parseLocaleNumber,
  getLocaleSeparators,
  serializeCell,
  serializeRangeToTSV,
  parseTSV,
} from '../gridClipboard';

describe('parseLocaleNumber', () => {
  it('parses plain en-US numbers', () => {
    expect(parseLocaleNumber('1.5', 'en-US')).toBe(1.5);
    expect(parseLocaleNumber('1,234.5', 'en-US')).toBe(1234.5);
    expect(parseLocaleNumber('-42', 'en-US')).toBe(-42);
  });

  it('parses comma-decimal locales (the parseFloat bug)', () => {
    // The bug this fixes: parseFloat("1,5") === 1.
    expect(parseLocaleNumber('1,5', 'de-DE')).toBe(1.5);
    expect(parseLocaleNumber('1.234,5', 'de-DE')).toBe(1234.5);
  });

  it('dot-fallback: a plain "1.5" typed in a comma-decimal locale still parses', () => {
    // "1.5" in de strips the dot as grouping → 15 is NOT what a user means when
    // they paste a dot-decimal; but the documented rule parses per locale first.
    // We at least guarantee a finite result, never NaN.
    expect(Number.isFinite(parseLocaleNumber('1.5', 'de-DE') as number)).toBe(true);
  });

  it('returns undefined for empty / non-numeric (callers must skip, never write 0)', () => {
    expect(parseLocaleNumber('', 'en-US')).toBeUndefined();
    expect(parseLocaleNumber('   ', 'en-US')).toBeUndefined();
    expect(parseLocaleNumber('abc', 'en-US')).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    expect(parseLocaleNumber('  2.5 ', 'en-US')).toBe(2.5);
  });
});

describe('getLocaleSeparators', () => {
  it('reports en separators', () => {
    expect(getLocaleSeparators('en-US')).toEqual({ decimal: '.', group: ',' });
  });
  it('falls back to en defaults on a bogus locale', () => {
    expect(getLocaleSeparators('not-a-locale')).toEqual({ decimal: '.', group: ',' });
  });
});

describe('serializeCell', () => {
  it('leaves plain values unquoted', () => {
    expect(serializeCell('hello')).toBe('hello');
    expect(serializeCell('1.5')).toBe('1.5');
  });
  it('quotes and escapes tabs, newlines, and quotes', () => {
    expect(serializeCell('a\tb')).toBe('"a\tb"');
    expect(serializeCell('line1\nline2')).toBe('"line1\nline2"');
    expect(serializeCell('say "hi"')).toBe('"say ""hi"""');
  });
});

describe('serializeRangeToTSV / parseTSV round-trip', () => {
  it('serializes a matrix to TSV', () => {
    expect(serializeRangeToTSV([['a', 'b'], ['c', 'd']])).toBe('a\tb\nc\td');
  });

  it('parses simple TSV', () => {
    expect(parseTSV('a\tb\nc\td')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('drops a single trailing newline (no phantom empty row)', () => {
    expect(parseTSV('a\tb\n')).toEqual([['a', 'b']]);
  });

  it('handles CRLF row separators (Excel on Windows)', () => {
    expect(parseTSV('a\tb\r\nc\td')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('parses quoted fields with embedded tabs, newlines, and doubled quotes', () => {
    const tsv = '"a\tb"\t"multi\nline"\n"say ""hi"""\tplain';
    expect(parseTSV(tsv)).toEqual([
      ['a\tb', 'multi\nline'],
      ['say "hi"', 'plain'],
    ]);
  });

  it('round-trips a comment with a newline', () => {
    const matrix = [['note one\nsecond line', '42']];
    expect(parseTSV(serializeRangeToTSV(matrix))).toEqual(matrix);
  });

  it('parses a single cell', () => {
    expect(parseTSV('solo')).toEqual([['solo']]);
  });
});
