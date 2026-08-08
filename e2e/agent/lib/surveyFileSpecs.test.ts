/**
 * What a generator has to be worth trusting is narrower than "it produces
 * files": a seed must reproduce the same file set, a `valid` spec must actually
 * survive the parser it was aimed at, and a corruption must be the one its id
 * claims. Those three are what these pin.
 *
 * The section-count check is the load-bearing one. `split_into_sections` cuts on
 * a `3` byte followed by a run of zeros, so a shot record that happens to be
 * mostly zeros silently splits a section in half - a file that still "parses",
 * with a different survey in it. The invariant documented at the top of
 * `surveyFileSpecs.ts` (never draw `length` or `markerIndex` as zero) is what
 * prevents it, and this checks the consequence over enough seeds that the
 * argument does not have to be taken on trust.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { corruptSpec, corruptionsFor } from './surveyFileCorrupt';
import {
  type GeneratedFileSpec,
  type Rng,
  HOSTILE_COMMENTS,
  materializeSurveyFile,
  randomDmpSpec,
  randomSurveyFileSpec,
  randomTmlSpec,
  renderSurveyFile,
} from './surveyFileSpecs';
import { dmpFileBytes, endOfSectionBytes, escapeXmlText, writeTmluXml } from './surveyFileWriters';

/**
 * A local copy of `scenarios/framework.ts`'s `mulberry32`.
 *
 * Copied rather than imported: `framework.ts` pulls in the WebdriverIO session
 * surface and, through `fixtures.ts`, `node:sqlite` - none of which a pure
 * generator test has any use for. The property under test is "the same stream
 * produces the same spec", which any deterministic PRNG demonstrates.
 */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `split_into_sections`, reduced to the count. */
function countSections(bytes: readonly number[], version: number): number {
  const patterns = [endOfSectionBytes(version, 'normal')];
  if (version === 5) patterns.push(endOfSectionBytes(version, 'buggy'));
  const length = patterns[0].length;
  if (length === 0 || bytes.length < length) return 0;
  let found = 0;
  for (let index = 0; index + length <= bytes.length; index++) {
    const window = bytes.slice(index, index + length);
    if (patterns.some((pattern) => pattern.every((value, offset) => value === window[offset]))) {
      found++;
      index += length - 1;
    }
  }
  return found;
}

const SEEDS = Array.from({ length: 120 }, (_unused, index) => index + 1);

describe('randomDmpSpec (valid)', () => {
  it('never lets a shot record terminate its own section', () => {
    for (const seed of SEEDS) {
      const spec = randomDmpSpec(mulberry32(seed), 'valid');
      expect(countSections(dmpFileBytes(spec), spec.version)).toBe(spec.sections.length);
    }
  });

  it('stays inside every range parse_section validates', () => {
    for (const seed of SEEDS) {
      const spec = randomDmpSpec(mulberry32(seed), 'valid');
      expect([2, 3, 4, 5]).toContain(spec.version);
      for (const section of spec.sections) {
        expect(section.year).toBeGreaterThanOrEqual(0);
        expect(section.year).toBeLessThanOrEqual(99);
        expect(section.month).toBeGreaterThanOrEqual(1);
        expect(section.month).toBeLessThanOrEqual(12);
        // Never 29..31: those exist in some months and not others, and a spec
        // that parses in March but not February is not a `valid` spec.
        expect(section.day).toBeGreaterThanOrEqual(1);
        expect(section.day).toBeLessThanOrEqual(28);
        expect(section.hour).toBeLessThanOrEqual(23);
        expect(section.minute).toBeLessThanOrEqual(59);
        expect([0, 1]).toContain(section.direction);
        expect(section.shots.length).toBeGreaterThan(0);
        for (const shot of section.shots) {
          expect([0, 1, 2]).toContain(shot.shotType);
          expect(shot.length).not.toBe(0);
          expect(shot.markerIndex).not.toBe(0);
        }
      }
    }
  });

  it('reaches the duplicate-content shape a re-import has to notice', () => {
    const clones = SEEDS.map((seed) => randomDmpSpec(mulberry32(seed), 'valid')).filter((spec) =>
      spec.sections.some((section) => section.sameContentAs !== undefined),
    );
    expect(clones.length).toBeGreaterThan(0);
  });
});

describe('randomTmlSpec (valid)', () => {
  it('builds a rooted tree with unique non-negative ids', () => {
    for (const seed of SEEDS) {
      const spec = randomTmlSpec(mulberry32(seed), 'valid');
      const ids = spec.shots.map((shot) => Number(shot.id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => id >= 0)).toBe(true);
      expect(spec.shots[0].type).toBe('START');
      expect(Number(spec.shots[0].fromId)).toBe(-1);
      for (let index = 1; index < spec.shots.length; index++) {
        expect(Number(spec.shots[index].fromId)).toBeLessThan(index);
        expect(Number(spec.shots[index].fromId)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('emits a document with no raw angle bracket outside a tag', () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const xml = writeTmluXml(randomTmlSpec(mulberry32(seed), 'valid'));
      // Every `<` must open a tag: text is escaped, so a `<` not followed by a
      // name or a slash means something leaked through unescaped.
      expect(/<(?![/?A-Za-z])/.test(xml)).toBe(false);
      expect(xml.match(/<Data>/g) ?? xml.match(/<Data\/>/g)).toHaveLength(1);
    }
  });
});

describe('determinism', () => {
  it('reproduces the same spec and the same bytes from the same seed', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      for (const profile of ['valid', 'malformed'] as const) {
        const a = randomSurveyFileSpec(mulberry32(seed), profile);
        const b = randomSurveyFileSpec(mulberry32(seed), profile);
        expect(b).toEqual(a);
        expect(b.name).toBe(a.name);
        expect([...renderSurveyFile(b)]).toEqual([...renderSurveyFile(a)]);
      }
    }
  });

  it('gives two identical specs the same content-addressed name', () => {
    const first = randomSurveyFileSpec(mulberry32(3), 'valid', 'dmp');
    const second = randomSurveyFileSpec(mulberry32(3), 'valid', 'dmp');
    // This is the mechanism behind "the user imported the same file twice":
    // no separate sameFileAs flag, just an emission that cannot differ.
    expect(second.name).toBe(first.name);
  });
});

describe('corruptSpec', () => {
  it('is deterministic in the rng, spec and all', () => {
    for (const seed of SEEDS.slice(0, 30)) {
      const clean = randomSurveyFileSpec(mulberry32(seed), 'valid');
      const a = corruptSpec(mulberry32(seed * 31), clean);
      const b = corruptSpec(mulberry32(seed * 31), clean);
      expect(b.corruption).toBe(a.corruption);
      expect(b.spec).toEqual(a.spec);
    }
  });

  it('leaves the clean spec untouched', () => {
    const clean = randomSurveyFileSpec(mulberry32(11), 'valid', 'dmp');
    const before = JSON.stringify(clean);
    corruptSpec(mulberry32(4), clean);
    expect(JSON.stringify(clean)).toBe(before);
  });

  it('only draws corruptions that apply to the target', () => {
    const tmlu = randomSurveyFileSpec(mulberry32(5), 'valid', 'tmlu');
    expect(corruptionsFor(tmlu).some((id) => id.startsWith('tml:zip-'))).toBe(false);
    const tml = randomSurveyFileSpec(mulberry32(5), 'valid', 'tml');
    expect(corruptionsFor(tml)).toContain('tml:zip-wrong-entry');

    for (const seed of SEEDS.slice(0, 60)) {
      const spec = randomSurveyFileSpec(mulberry32(seed), 'valid', 'dmp');
      const ids = corruptionsFor(spec);
      if (spec.dmp.version < 5) {
        expect(ids).not.toContain('dmp:bad-shot-start-magic');
        expect(ids).not.toContain('dmp:buggy-eos');
      }
      if (spec.dmp.version === 2) expect(ids).not.toContain('dmp:bad-section-magic');
      // Whatever the version, the id drawn is one the catalog offered.
      expect(ids).toContain(corruptSpec(mulberry32(seed + 7), spec).corruption);
    }
  });

  it('renders every catalog entry to bytes without throwing, and bounds the big one', () => {
    const seen = new Set<string>();
    for (const seed of Array.from({ length: 600 }, (_unused, index) => index + 1)) {
      const clean = randomSurveyFileSpec(mulberry32(seed), 'valid');
      const { spec, corruption } = corruptSpec(mulberry32(seed * 7919), clean);
      const bytes = renderSurveyFile(spec);
      seen.add(corruption);
      expect(bytes.length).toBeLessThanOrEqual(4 * 1024 * 1024);
      if (corruption === 'dmp:oversized') expect(bytes.length).toBeGreaterThan(512 * 1024);
    }
    // Enough of the catalog is reachable that a run of a few hundred iterations
    // is really covering rejection paths, not re-drawing three of them.
    expect(seen.size).toBeGreaterThan(30);
  });
});

describe('HOSTILE_COMMENTS', () => {
  it('escapes to text with no markup left in it', () => {
    for (const comment of HOSTILE_COMMENTS) {
      const escaped = escapeXmlText(comment);
      expect(escaped).not.toMatch(/[<>]/);
      // Every surviving `&` is the start of one of the five entities.
      expect(escaped.replace(/&(amp|lt|gt|quot|apos);/g, '')).not.toContain('&');
    }
  });

  it('carries the shapes the catalog documents', () => {
    expect(HOSTILE_COMMENTS).toContain("=cmd|' /C calc'!A0");
    expect(HOSTILE_COMMENTS.some((text) => text.startsWith('\t'))).toBe(true);
    expect(HOSTILE_COMMENTS.some((text) => text.startsWith('\r'))).toBe(true);
    expect(HOSTILE_COMMENTS.some((text) => text.includes('\u200b'))).toBe(true);
    expect(HOSTILE_COMMENTS.some((text) => text.includes('\u202e'))).toBe(true);
    expect(HOSTILE_COMMENTS.some((text) => text.length >= 8 * 1024)).toBe(true);
    // A lone surrogate would not survive TextEncoder, so the corpus carries the
    // replacement character instead and says so.
    expect(HOSTILE_COMMENTS.some((text) => text.includes('\ufffd'))).toBe(true);
    for (const text of HOSTILE_COMMENTS) {
      expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(text);
    }
  });
});

describe('materializeSurveyFile', () => {
  it('writes the rendered bytes under the spec name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-fuzz-files-'));
    try {
      const spec = randomSurveyFileSpec(mulberry32(2), 'valid', 'dmp');
      const nested = path.join(dir, 'fuzz-files');
      const written = materializeSurveyFile(nested, spec);
      expect(written.path).toBe(path.join(nested, spec.name));
      expect(fs.readFileSync(written.path)).toEqual(Buffer.from(written.bytes));
      expect(spec.name.endsWith('.dmp')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a name that is not a plain basename', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-fuzz-files-'));
    try {
      const spec = randomSurveyFileSpec(mulberry32(2), 'valid', 'dmp');
      for (const name of ['../escape.dmp', 'sub/dir.dmp', '', '.hidden.dmp']) {
        const hostile = { ...spec, name } as GeneratedFileSpec;
        expect(() => materializeSurveyFile(dir, hostile)).toThrow(/plain basename/);
      }
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
