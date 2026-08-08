/**
 * Everything here runs against a SYNTHETIC corpus built in a temp dir under
 * names this file invented. No real corpus is read, no real path appears, and
 * the tests pass identically on a machine that has never had one - which is the
 * whole contract: an unconfigured corpus is a supported configuration, not a
 * degraded one.
 *
 * The two properties worth the most are the ones a private-data rule depends on:
 * the env knob is read at CALL time (a replay restores the recording's
 * environment after this module was imported), and `corpusFileId` is what
 * identifies a file downstream, so it has to be stable and path-derived.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CORPUS_DIR_ENV,
  MAX_MATERIALIZED_BYTES,
  corpusAvailable,
  corpusDir,
  corpusEntryFor,
  corpusFileId,
  describeCorpus,
  discoverCorpus,
  materializeCorpusEntry,
} from './fixtureCorpus';

let root = '';
let saved: string | undefined;

/** A fake corpus: two importable formats, a multi-file project, and noise. */
function buildFakeCorpus(dir: string): void {
  fs.mkdirSync(path.join(dir, 'device'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'project', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'device', 'alpha.dmp'), '5;68;89;101');
  fs.writeFileSync(path.join(dir, 'device', 'beta.DMP'), '2;0;0');
  fs.writeFileSync(path.join(dir, 'device', 'readme.txt'), 'not importable');
  fs.writeFileSync(path.join(dir, 'project', 'survey.mak'), '#survey.dat;');
  fs.writeFileSync(path.join(dir, 'project', 'survey.dat'), 'compass data');
  fs.writeFileSync(path.join(dir, 'project', 'photo.jpg'), 'binary-ish');
  fs.writeFileSync(path.join(dir, 'project', 'nested', 'deep.tmlu'), '<CaveFile/>');
}

beforeEach(() => {
  saved = process.env[CORPUS_DIR_ENV];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-fake-corpus-'));
  buildFakeCorpus(root);
});

afterEach(() => {
  if (saved === undefined) delete process.env[CORPUS_DIR_ENV];
  else process.env[CORPUS_DIR_ENV] = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('configuration', () => {
  it('reads the knob at call time, so a replay that sets it later is honoured', () => {
    delete process.env[CORPUS_DIR_ENV];
    expect(corpusDir()).toBeNull();
    expect(corpusAvailable()).toBe(false);
    expect(discoverCorpus().entries).toEqual([]);

    // The module was imported while the knob was unset. If it had frozen the
    // value, this would still report nothing.
    process.env[CORPUS_DIR_ENV] = root;
    expect(corpusDir()).toBe(root);
    expect(corpusAvailable()).toBe(true);
    expect(discoverCorpus().entries.length).toBeGreaterThan(0);
  });

  it('treats an empty, blank or missing directory as no corpus, without throwing', () => {
    for (const value of ['', '   ']) {
      process.env[CORPUS_DIR_ENV] = value;
      expect(corpusDir()).toBeNull();
      expect(corpusAvailable()).toBe(false);
    }
    process.env[CORPUS_DIR_ENV] = path.join(root, 'does-not-exist');
    expect(corpusAvailable()).toBe(false);
    const inventory = discoverCorpus();
    expect(inventory.available).toBe(false);
    expect(inventory.root).toBeNull();
    expect(describeCorpus(inventory)).toContain('none');
  });

  it('bakes in no default path', () => {
    delete process.env[CORPUS_DIR_ENV];
    // A default would make the harness read somebody's disk on a machine that
    // never opted in, and would name a location in the public tree.
    expect(corpusDir()).toBeNull();
  });
});

describe('discoverCorpus', () => {
  beforeEach(() => {
    process.env[CORPUS_DIR_ENV] = root;
  });

  it('finds importable files at any depth and ignores everything else', () => {
    const inventory = discoverCorpus();
    expect(inventory.available).toBe(true);
    expect(inventory.root).toBe(root);
    expect(inventory.entries.map((entry) => entry.relPath).sort()).toEqual([
      'device/alpha.dmp',
      'device/beta.DMP',
      'project/nested/deep.tmlu',
      'project/survey.dat',
      'project/survey.mak',
    ]);
  });

  it('groups by format, matching the extension case-insensitively', () => {
    const { byFormat } = discoverCorpus();
    expect(byFormat.dmp.map((entry) => entry.relPath)).toEqual(['device/alpha.dmp', 'device/beta.DMP']);
    expect(byFormat.tmlu).toHaveLength(1);
    expect(byFormat.mak).toHaveLength(1);
    expect(byFormat.gpx).toEqual([]);
  });

  it('is ordered the same on every filesystem', () => {
    // A `ctx.pick` over the inventory has to be reproducible from a seed, and
    // readdir order is not a property of the corpus.
    expect(discoverCorpus().entries).toEqual(discoverCorpus().entries);
    expect(discoverCorpus().entries.map((entry) => entry.relPath)).toEqual([
      'device/alpha.dmp',
      'device/beta.DMP',
      'project/nested/deep.tmlu',
      'project/survey.dat',
      'project/survey.mak',
    ]);
  });

  it('describes itself with counts and no names', () => {
    const line = describeCorpus(discoverCorpus());
    expect(line).toContain('5 file(s)');
    expect(line).toContain('dmp=2');
    expect(line).not.toContain('alpha');
    expect(line).not.toContain(root);
  });

  it('resolves an entry back from its relative path', () => {
    expect(corpusEntryFor('device/alpha.dmp')?.format).toBe('dmp');
    expect(corpusEntryFor('nope.dmp')).toBeNull();
  });
});

describe('corpusFileId', () => {
  it('is 5 hex characters, stable, and derived only from the relative path', () => {
    const id = corpusFileId('device/alpha.dmp');
    expect(id).toMatch(/^[0-9a-f]{5}$/);
    expect(corpusFileId('device/alpha.dmp')).toBe(id);
    expect(corpusFileId('device/beta.DMP')).not.toBe(id);
  });

  it('is what the inventory carries, so nothing downstream needs the name', () => {
    process.env[CORPUS_DIR_ENV] = root;
    for (const entry of discoverCorpus().entries) {
      expect(entry.id).toBe(corpusFileId(entry.relPath));
      // The id must not leak the name it stands for.
      expect(path.basename(entry.relPath).toLowerCase()).not.toContain(entry.id);
    }
  });
});

describe('materializeCorpusEntry', () => {
  beforeEach(() => {
    process.env[CORPUS_DIR_ENV] = root;
  });

  it('copies the whole containing directory, because a .mak is not one file', () => {
    const dest = path.join(root, '..', path.basename(root) + '-dest');
    try {
      const entry = corpusEntryFor('project/survey.mak');
      expect(entry).not.toBeNull();
      const result = materializeCorpusEntry(entry!, dest);
      expect(result.skipped).toBe(false);
      expect(result.path).toBe(path.join(dest, 'survey.mak'));
      // The sibling `.dat` the project references came with it.
      expect(fs.existsSync(path.join(dest, 'survey.dat'))).toBe(true);
      expect(fs.readFileSync(result.path, 'utf8')).toBe('#survey.dat;');
      // Subdirectories are not part of the unit.
      expect(fs.existsSync(path.join(dest, 'nested'))).toBe(false);
      expect(result.copied).toBe(3);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('never lets the app reach the original', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-corpus-dest-'));
    try {
      const entry = corpusEntryFor('device/alpha.dmp')!;
      const result = materializeCorpusEntry(entry, dest);
      fs.writeFileSync(result.path, 'the app migrated this file');
      // The original is untouched, which is the only reason this is allowed to
      // point at somebody's unversioned data at all.
      expect(fs.readFileSync(path.join(root, 'device', 'alpha.dmp'), 'utf8')).toBe('5;68;89;101');
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('skips a directory over the bound instead of copying it', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-corpus-dest-'));
    try {
      // Sparse: the size is what the bound reads, and writing 64 MB of real
      // bytes into a unit test would be the cost this bound exists to avoid.
      const big = path.join(root, 'device', 'huge.dmp');
      const handle = fs.openSync(big, 'w');
      fs.ftruncateSync(handle, MAX_MATERIALIZED_BYTES + 1);
      fs.closeSync(handle);

      const entry = corpusEntryFor('device/alpha.dmp')!;
      const result = materializeCorpusEntry(entry, dest);
      expect(result.skipped).toBe(true);
      expect(result.copied).toBe(0);
      expect(result.bytes).toBeGreaterThan(MAX_MATERIALIZED_BYTES);
      expect(fs.readdirSync(dest)).toEqual([]);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('refuses to run with no corpus configured', () => {
    const entry = corpusEntryFor('device/alpha.dmp')!;
    delete process.env[CORPUS_DIR_ENV];
    expect(() => materializeCorpusEntry(entry, root)).toThrow(new RegExp(CORPUS_DIR_ENV));
  });
});
