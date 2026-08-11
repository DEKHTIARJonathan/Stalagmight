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
  MAX_MATERIALIZED_DEPTH,
  MAX_MATERIALIZED_FILES,
  MAX_WALK_DEPTH,
  corpusAvailable,
  corpusDir,
  corpusEntryFor,
  corpusFileId,
  corpusLookup,
  corpusPathHash,
  describeCorpus,
  discoverCorpus,
  materializeCorpusEntry,
  type CorpusEntry,
} from './fixtureCorpus';

let root = '';
let saved: string | undefined;

/**
 * Two synthetic relative paths whose crc20 `corpusFileId` is the SAME.
 *
 * Found by enumerating invented names, never by hunting the private corpus for
 * a real colliding pair - the point is the arithmetic, and the arithmetic does
 * not care whose files these are. 20 bits is one million buckets, so a corpus of
 * a few thousand files is more likely than not to hold such a pair for real.
 */
const TWIN_A = 'twins/cave-2834.tml';
const TWIN_B = 'twins/cave-70000.tml';

/**
 * A fake corpus: two importable formats, a multi-file project, a Walls-shaped
 * project whose companions live BELOW it, and noise.
 *
 * The Walls shape is the one that matters most. A `.wpj` names its surveys with
 * `.PATH` directives that descend into subfolders, so a materialization that
 * takes only the immediate children hands the app a project file and none of the
 * project.
 */
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

  fs.mkdirSync(path.join(dir, 'walls', 'branch', 'deeper'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'walls', 'trip.wpj'),
    ['.BOOK trip', '.PATH branch', '.SURVEY a', '.NAME a', '.PATH branch/deeper', '.SURVEY b', '.NAME b'].join('\n'),
  );
  fs.writeFileSync(path.join(dir, 'walls', 'branch', 'a.srv'), 'A1 A2 10 90 0');
  fs.writeFileSync(path.join(dir, 'walls', 'branch', 'deeper', 'b.srv'), 'B1 B2 10 90 0');
  fs.writeFileSync(path.join(dir, 'walls', 'branch', 'deeper', 'notes.txt'), 'unrelated');
}

/** Add the colliding pair. Separate, so most tests see a collision-free corpus. */
function addColliders(dir: string): void {
  for (const rel of [TWIN_A, TWIN_B]) {
    const target = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `<CaveFile name="${path.basename(rel)}"/>`);
  }
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

  const EVERY_ENTRY = [
    'device/alpha.dmp',
    'device/beta.DMP',
    'project/nested/deep.tmlu',
    'project/survey.dat',
    'project/survey.mak',
    'walls/branch/a.srv',
    'walls/branch/deeper/b.srv',
    'walls/trip.wpj',
  ];

  it('finds importable files at any depth and ignores everything else', () => {
    const inventory = discoverCorpus();
    expect(inventory.available).toBe(true);
    expect(inventory.root).toBe(root);
    expect(inventory.entries.map((entry) => entry.relPath).sort()).toEqual([...EVERY_ENTRY].sort());
  });

  it('groups by format, matching the extension case-insensitively', () => {
    const { byFormat } = discoverCorpus();
    expect(byFormat.dmp.map((entry) => entry.relPath)).toEqual(['device/alpha.dmp', 'device/beta.DMP']);
    expect(byFormat.tmlu).toHaveLength(1);
    expect(byFormat.mak).toHaveLength(1);
    expect(byFormat.wpj).toHaveLength(1);
    expect(byFormat.srv).toHaveLength(2);
    expect(byFormat.gpx).toEqual([]);
  });

  it('is ordered the same on every filesystem', () => {
    // A `ctx.pick` over the inventory has to be reproducible from a seed, and
    // readdir order is not a property of the corpus.
    expect(discoverCorpus().entries).toEqual(discoverCorpus().entries);
    expect(discoverCorpus().entries.map((entry) => entry.relPath)).toEqual(EVERY_ENTRY);
  });

  it('describes itself with counts and no names', () => {
    const line = describeCorpus(discoverCorpus());
    expect(line).toContain(`${EVERY_ENTRY.length} file(s)`);
    expect(line).toContain('dmp=2');
    expect(line).not.toContain('alpha');
    expect(line).not.toContain(root);
  });

  it('resolves an entry back from its relative path', () => {
    expect(corpusEntryFor('device/alpha.dmp')?.format).toBe('dmp');
    expect(corpusEntryFor('nope.dmp')).toBeNull();
  });

  it('resolves an entry back from its ID and from its path hash', () => {
    // A `corpusFile` trace step names its file by `corpusFileId` and resolves it
    // by `corpusPathHash`, so replaying one means scanning THIS inventory - the
    // replayer's own corpus - for the entry that matches.
    const alpha = corpusEntryFor('device/alpha.dmp');
    expect(alpha).not.toBeNull();
    expect(corpusEntryFor(alpha!.id)?.relPath).toBe('device/alpha.dmp');
    expect(corpusEntryFor(alpha!.pathHash)?.relPath).toBe('device/alpha.dmp');
    for (const entry of discoverCorpus().entries) {
      expect(corpusEntryFor(entry.id)).toEqual(entry);
      expect(corpusEntryFor(entry.pathHash)).toEqual(entry);
    }
  });

  it('returns null for a reference this corpus does not have, which is the skip case', () => {
    // A trace recorded against somebody else's corpus, or on a machine that has
    // one at all. The replayer counts the move and skips it; a missing corpus
    // file is never a failure, because a corpus is optional by design.
    expect(corpusEntryFor(corpusFileId('somebody-elses/unrelated-cave.dmp'))).toBeNull();
    expect(corpusEntryFor(corpusPathHash('somebody-elses/unrelated-cave.dmp'))).toBeNull();
    expect(corpusEntryFor('00000')).toBeNull();
    expect(corpusLookup('00000').outcome).toBe('missing');
  });

  it('keeps the three key spaces disjoint, so one lookup can serve all of them', () => {
    // An id is five bare hex characters and a hash is sixteen; every path the
    // walk yields carries one of the importable extensions. Nothing can be read
    // as more than one of the three.
    for (const entry of discoverCorpus().entries) {
      expect(entry.id).toMatch(/^[0-9a-f]{5}$/);
      expect(entry.pathHash).toMatch(/^[0-9a-f]{16}$/);
      expect(entry.relPath).not.toMatch(/^[0-9a-f]{5}$/);
      expect(entry.relPath).not.toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe('the discovery walk bounds', () => {
  /**
   * A single synthetic chain, pinning the depth bound from BOTH sides.
   *
   * `at-bound.srv` sits at exactly `MAX_WALK_DEPTH` directory levels below the
   * root and `past-bound.srv` one level further, so an off-by-one in either
   * direction shows up here as a missing file or an extra one - a test that
   * only had the "deep file is found" half would pass just as happily with no
   * bound at all, and one that only had the "too deep is refused" half would
   * pass with the bound set anywhere.
   *
   * Invented names, invented shape. The real corpus is never read by a test;
   * that it happened to grow past the old bound is the reason this exists and
   * not something any assertion here depends on.
   */
  const levelNames = (levels: number): string[] => Array.from({ length: levels }, (_, i) => `L${i + 1}`);
  const relOf = (levels: number, name: string): string => [...levelNames(levels), name].join('/');
  const AT_BOUND = relOf(MAX_WALK_DEPTH, 'at-bound.srv');
  const PAST_BOUND = relOf(MAX_WALK_DEPTH + 1, 'past-bound.srv');

  beforeEach(() => {
    const past = path.join(root, ...levelNames(MAX_WALK_DEPTH + 1));
    fs.mkdirSync(past, { recursive: true });
    fs.writeFileSync(path.join(root, ...levelNames(MAX_WALK_DEPTH), 'at-bound.srv'), 'A1 A2 10 90 0');
    fs.writeFileSync(path.join(past, 'past-bound.srv'), 'B1 B2 10 90 0');
    // A second file behind the same refused door, so the counter's unit is
    // pinned as DIRECTORIES not descended into rather than files not seen.
    fs.writeFileSync(path.join(past, 'past-bound-two.srv'), 'C1 C2 10 90 0');
    process.env[CORPUS_DIR_ENV] = root;
  });

  it('finds a file at exactly the depth bound', () => {
    const inventory = discoverCorpus();
    expect(inventory.entries.map((entry) => entry.relPath)).toContain(AT_BOUND);
    expect(corpusEntryFor(AT_BOUND)?.format).toBe('srv');
  });

  it('refuses the level below it - and COUNTS the refusal instead of hiding it', () => {
    // The bug this whole change is about: an undiscovered file leaves no trace
    // anywhere, so a walk that is one level too shallow reports a smaller
    // corpus with total confidence and nothing in the output distinguishes
    // "this is all there is" from "this is all I looked at".
    const inventory = discoverCorpus();
    expect(inventory.entries.map((entry) => entry.relPath)).not.toContain(PAST_BOUND);
    // ONE, with two importable files behind it: the unit is doors not opened,
    // because counting the files would mean walking what the bound refused.
    expect(inventory.tooDeep).toBe(1);
    // And it is its own counter, not folded into the general skip count, so a
    // corpus that has outgrown the bound is distinguishable from an unreadable
    // directory - the two have completely different answers.
    expect(inventory.skipped).toBe(0);
  });

  it('says it in the one line a run prints, without naming anything', () => {
    const line = describeCorpus(discoverCorpus());
    expect(line).toContain(`deeper than ${MAX_WALK_DEPTH} levels`);
    expect(line).toContain('lower bound');
    for (const segment of PAST_BOUND.split('/')) expect(line).not.toContain(segment);
  });

  it('walks exactly as deep as the materialization copy, deliberately and not by luck', () => {
    // Discovery and materialization are two halves of one operation. Shallower
    // discovery hides files the copy would take; deeper discovery draws entries
    // the copy then refuses on every iteration. Pinned here so moving one alone
    // fails rather than silently producing one of those two.
    expect(MAX_WALK_DEPTH).toBe(MAX_MATERIALIZED_DEPTH);
  });

  it('stays bounded: nothing it yields is deeper than the bound', () => {
    for (const entry of discoverCorpus().entries) {
      expect(entry.relPath.split('/').length - 1).toBeLessThanOrEqual(MAX_WALK_DEPTH);
    }
  });

  it('does not follow a symlink, to a directory or to a file', () => {
    // A corpus is somebody's data directory; a link out of it would put the
    // walk somewhere they did not point us, and everything discovered here is
    // later COPIED. The deeper walk changes nothing about that.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-corpus-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.srv'), 'not ours');
      fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');
      fs.symlinkSync(path.join(outside, 'secret.srv'), path.join(root, 'linked.srv'), 'file');
      const relPaths = discoverCorpus().entries.map((entry) => entry.relPath);
      expect(relPaths).not.toContain('linked/secret.srv');
      expect(relPaths).not.toContain('linked.srv');
      expect(relPaths.some((rel) => rel.includes('secret'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('terminates on a link that points back at the corpus root', () => {
    // Not following links is also what makes the recursion terminate without a
    // visited set. A followed self-link would re-walk the whole tree at every
    // level until the depth bound stopped it, yielding the same files over and
    // over under different paths - so "no duplicates" is the observable form of
    // "this walk cannot be made to spin".
    fs.symlinkSync(root, path.join(root, 'self'), 'dir');
    const relPaths = discoverCorpus().entries.map((entry) => entry.relPath);
    expect(new Set(relPaths).size).toBe(relPaths.length);
    expect(relPaths.some((rel) => rel.startsWith('self/'))).toBe(false);
  });
});

describe('a crc20 id that names two files', () => {
  beforeEach(() => {
    addColliders(root);
    process.env[CORPUS_DIR_ENV] = root;
  });

  it('is exactly what the synthetic pair produces, so the rest of this block is not vacuous', () => {
    expect(corpusFileId(TWIN_A)).toBe(corpusFileId(TWIN_B));
    expect(corpusPathHash(TWIN_A)).not.toBe(corpusPathHash(TWIN_B));
  });

  it('is detected at discovery and named - the IDS, never the paths', () => {
    const inventory = discoverCorpus();
    expect(inventory.idCollisions).toEqual([corpusFileId(TWIN_A)]);
    const line = describeCorpus(inventory);
    expect(line).toContain('WARNING');
    expect(line).toContain(corpusFileId(TWIN_A));
    // The rule that does not move: a warning about private files does not name
    // any of them.
    for (const rel of [TWIN_A, TWIN_B]) {
      for (const segment of rel.split('/')) expect(line).not.toContain(segment);
    }
  });

  it('resolves to NOTHING rather than to the first match', () => {
    // The bug this exists for: `entries.find(e => e.id === reference)` handed
    // back whichever file the walk happened to reach first, so a replay
    // materialized somebody else's survey and then opened it under the recorded
    // file's name. A narrower replay is fine; a wrong one is not.
    const lookup = corpusLookup(corpusFileId(TWIN_A));
    expect(lookup.outcome).toBe('ambiguous');
    expect(lookup.entry).toBeNull();
    expect(lookup.matches).toBe(2);
    expect(corpusEntryFor(corpusFileId(TWIN_A))).toBeNull();
  });

  it('still resolves each twin exactly by its path hash, which is what a trace carries', () => {
    expect(corpusLookup(corpusPathHash(TWIN_A))).toMatchObject({ outcome: 'found', matches: 1 });
    expect(corpusEntryFor(corpusPathHash(TWIN_A))?.relPath).toBe(TWIN_A);
    expect(corpusEntryFor(corpusPathHash(TWIN_B))?.relPath).toBe(TWIN_B);
  });

  it('leaves every other id alone', () => {
    expect(corpusEntryFor(corpusFileId('device/alpha.dmp'))?.relPath).toBe('device/alpha.dmp');
    expect(discoverCorpus().idCollisions).toHaveLength(1);
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
      expect(result.reason).toBeNull();
      expect(result.path).toBe(path.join(dest, 'survey.mak'));
      // The sibling `.dat` the project references came with it.
      expect(fs.existsSync(path.join(dest, 'survey.dat'))).toBe(true);
      expect(fs.readFileSync(result.path, 'utf8')).toBe('#survey.dat;');
      // Non-importable siblings too - a Compass project can name a `.clp`, and
      // a whitelist would turn a real parse into a fake one.
      expect(fs.existsSync(path.join(dest, 'photo.jpg'))).toBe(true);
      expect(result.copied).toBe(4);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('copies SUBDIRECTORIES too, because a Walls .PATH descends', () => {
    // The bug: the copy took `listing.filter(item => item.isFile())`, so a
    // `.wpj` whose `.PATH` directives name subfolders arrived with the project
    // file and none of the project. Measured on the corpus this integration was
    // written for, that took 1 file of 275 on one project and 1 of 14 on
    // another - so both were exercising missing-file handling and being counted
    // as coverage of a real Walls project.
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-corpus-dest-'));
    try {
      const entry = corpusEntryFor('walls/trip.wpj')!;
      const result = materializeCorpusEntry(entry, dest);
      expect(result.skipped).toBe(false);
      expect(result.path).toBe(path.join(dest, 'trip.wpj'));
      // Structure PRESERVED, so the relative paths in the project file resolve.
      expect(fs.readFileSync(path.join(dest, 'branch', 'a.srv'), 'utf8')).toBe('A1 A2 10 90 0');
      expect(fs.readFileSync(path.join(dest, 'branch', 'deeper', 'b.srv'), 'utf8')).toBe('B1 B2 10 90 0');
      expect(fs.existsSync(path.join(dest, 'branch', 'deeper', 'notes.txt'))).toBe(true);
      expect(result.copied).toBe(4);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('reports every name it created, at any depth, so a caller can redact them', () => {
    // A `.PATH` subfolder can name a cave system exactly as well as a file can,
    // and `importDialogFuzz` builds its redaction list from this.
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-corpus-dest-'));
    try {
      const result = materializeCorpusEntry(corpusEntryFor('walls/trip.wpj')!, dest);
      expect(result.names).toEqual(['a.srv', 'b.srv', 'branch', 'deeper', 'notes.txt', 'trip.wpj']);
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

  it('skips a tree over the byte bound instead of copying it', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-corpus-dest-'));
    try {
      // Sparse: the size is what the bound reads, and writing 64 MB of real
      // bytes into a unit test would be the cost this bound exists to avoid.
      // Put it in a SUBDIRECTORY, so this also pins that the bound measures the
      // whole tree the copy would take rather than one level of it.
      fs.mkdirSync(path.join(root, 'device', 'archive'), { recursive: true });
      const big = path.join(root, 'device', 'archive', 'huge.dmp');
      const handle = fs.openSync(big, 'w');
      fs.ftruncateSync(handle, MAX_MATERIALIZED_BYTES + 1);
      fs.closeSync(handle);

      const entry = corpusEntryFor('device/alpha.dmp')!;
      const result = materializeCorpusEntry(entry, dest);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('bytes');
      expect(result.copied).toBe(0);
      expect(result.path).toBe('');
      expect(result.bytes).toBeGreaterThan(MAX_MATERIALIZED_BYTES);
      // NOTHING, not a prefix. A half-copied project reads as a corrupt one from
      // inside the app, and the fuzzer would file the difference against the
      // importer.
      expect(fs.readdirSync(dest)).toEqual([]);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('skips a tree over the file-count bound, copying nothing', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-corpus-dest-'));
    try {
      const many = path.join(root, 'device', 'many');
      fs.mkdirSync(many, { recursive: true });
      for (let i = 0; i <= MAX_MATERIALIZED_FILES; i += 1) fs.writeFileSync(path.join(many, `f${i}`), '');
      const result = materializeCorpusEntry(corpusEntryFor('device/alpha.dmp')!, dest);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('files');
      expect(fs.readdirSync(dest)).toEqual([]);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('skips a tree deeper than the depth bound, copying nothing', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-corpus-dest-'));
    try {
      const deep = path.join(root, 'device', ...Array(MAX_MATERIALIZED_DEPTH + 1).fill('d'));
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(deep, 'bottom.srv'), 'x');
      const result = materializeCorpusEntry(corpusEntryFor('device/alpha.dmp')!, dest);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('depth');
      expect(fs.readdirSync(dest)).toEqual([]);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('does not follow a symlinked subdirectory out of the tree', () => {
    // Same reason the discovery walk does not follow one: a link can point at
    // somebody's home directory, and this function COPIES what it walks.
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-corpus-dest-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-corpus-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.srv'), 'not ours');
      fs.symlinkSync(outside, path.join(root, 'walls', 'linked'), 'dir');
      const result = materializeCorpusEntry(corpusEntryFor('walls/trip.wpj')!, dest);
      expect(result.skipped).toBe(false);
      expect(result.names).not.toContain('linked');
      expect(result.names).not.toContain('secret.srv');
      expect(fs.existsSync(path.join(dest, 'linked'))).toBe(false);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses to run with no corpus configured', () => {
    const entry = corpusEntryFor('device/alpha.dmp')!;
    delete process.env[CORPUS_DIR_ENV];
    expect(() => materializeCorpusEntry(entry, root)).toThrow(new RegExp(CORPUS_DIR_ENV));
  });

  it('names an unreadable entry by its ID and its errno, never by its path', () => {
    // Node builds an fs error message out of the full path it tried - "ENOENT:
    // no such file or directory, stat '/home/.../<a real cave name>/...'" - and
    // this throw is NOT caught by the scenario's `sourceOnDisk`, so it escapes
    // into the failure payload before any redaction for the entry exists, and
    // from there into the printed detail and the campaign report.
    const entry = corpusEntryFor('device/alpha.dmp')!;
    const vanished: CorpusEntry = { ...entry, relPath: 'device-that-is-gone/secret-cave-name.dmp' };

    let message = '';
    try {
      materializeCorpusEntry(vanished, path.join(root, 'out'));
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).not.toBe('');
    expect(message).toContain(entry.id);
    // The two segments of the path it failed on, and the separator itself.
    expect(message).not.toContain('device-that-is-gone');
    expect(message).not.toContain('secret-cave-name');
    expect(message).not.toContain(root);
    expect(message).not.toContain(path.sep);
    // The errno still comes through, so the failure is still diagnosable.
    expect(message).toMatch(/\((ENOENT|ENOTDIR|EACCES|io)\)$/);
  });
});
