/**
 * Optional integration with a PRIVATE corpus of real survey files.
 *
 * Generated files reach the parsers' edges; real files reach the shapes nobody
 * would think to generate - a `.mak` whose sibling `.dat` files are named in a
 * way one importer tolerates, a 57 MB `Data.xml`, a decade of drift in what a
 * device actually writes. A contributor who HAS such files can point the fuzzer
 * at them; everyone else gets an empty inventory and a run that is exactly as
 * valid, just narrower.
 *
 * ## Nothing here is ever published
 *
 * The repo forbids committing survey fixtures outright (CLAUDE.md, "Never commit
 * or extract fixtures"), and the reason is that a filename alone can identify a
 * cave, a landowner or an unpublished survey project. So:
 *
 *   - the corpus root is read from the environment, at CALL time, with NO
 *     default path - nothing in the tracked tree names a location;
 *   - a discovered file is identified downstream by `corpusFileId`, a 5-hex-char
 *     fold of its RELATIVE path, and that id is what a failure payload, a metric
 *     key, a log line and every rendered trace line carry. The real name never
 *     leaves this module - `corpusEntryFor` takes the id back the other way, so
 *     a replay never needs it either;
 *   - the app is only ever pointed at a COPY, so an import that migrates or
 *     rewrites a file cannot touch the original.
 *
 * ## Two identities, and why the short one is not enough on its own
 *
 * `corpusFileId` is 20 bits. That is ample for TELLING TWO FILES APART IN ONE
 * RUN's output, which is what it was built for, and far too little to RESOLVE
 * one: discovery permits 20000 entries, and by the birthday bound a corpus of a
 * few thousand files is more likely than not to hold a colliding pair. A replay
 * that looked an id up and took the first match would then materialize somebody
 * else's file and go on to open it under the recorded file's name, which is a
 * silently wrong replay - the one outcome worse than a skipped one.
 *
 * So an entry carries BOTH:
 *
 *   - `id`   - the 5-hex crc20. The ONLY identifier that appears in anything
 *              publishable: log lines, metric keys, failure payloads, issue
 *              text, `describeSteps` output. This is the privacy rule and it
 *              does not move.
 *   - `pathHash` - 16 hex characters of SHA-256 over the same relative path.
 *              A LOOKUP key, never rendered. A trace step may carry it (see
 *              `fuzzTrace.ts`'s `corpusFile` step) so a replay resolves the file
 *              it recorded rather than one that folds to the same 20 bits.
 *
 * Discovery also COUNTS crc20 collisions and reports the colliding ids (never
 * the paths), so a run whose metric keys are ambiguous says so out loud, and a
 * bare-id lookup that matches more than one entry resolves to NOTHING rather
 * than to a guess.
 *
 * ## Read at call time, never frozen
 *
 * `STALAGMIGHT_FUZZ_CORPUS_DIR` is read inside every function, never captured in
 * a module-level const. Same rule as `streamV2()` in
 * `scenarios/undoRedoFuzzActions.ts`: a replay restores the recording's
 * environment from inside its own `main()`, which runs long after this module
 * was imported, and a frozen const would silently replay against the wrong
 * corpus (or against none).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { shortId } from './crc32';

/** The env knob. Unset means "no corpus", which is a supported configuration. */
export const CORPUS_DIR_ENV = 'STALAGMIGHT_FUZZ_CORPUS_DIR';

/** Extensions the app has an importer for, mapped to the format name. */
const FORMAT_BY_EXTENSION: Readonly<Record<string, CorpusFormat>> = {
  '.dmp': 'dmp',
  '.tml': 'tml',
  '.tmlu': 'tmlu',
  '.dat': 'dat',
  '.mak': 'mak',
  '.srv': 'srv',
  '.wpj': 'wpj',
  '.gpx': 'gpx',
};

export type CorpusFormat = 'dmp' | 'tml' | 'tmlu' | 'dat' | 'mak' | 'srv' | 'wpj' | 'gpx';

export interface CorpusEntry {
  /** POSIX-style path relative to the corpus root. Never logged, never recorded; see `id`. */
  relPath: string;
  format: CorpusFormat;
  /** The publishable stand-in for `relPath`. Short, and therefore collidable. */
  id: string;
  /** The RESOLUTION key: 16 hex of SHA-256 over `relPath`. Never rendered. */
  pathHash: string;
  /** Size in bytes, so a caller can skip what it does not want to open. */
  bytes: number;
}

export interface CorpusInventory {
  /**
   * Are there entries to draw from? The question every CALLER asks.
   *
   * Not the same question as `configured`, and conflating the two is what hid
   * the bound this module counts: a corpus whose every file sits below
   * `MAX_WALK_DEPTH` discovers zero entries, so `available` is false and the
   * run reported "corpus: none (unset or empty)" - the one message that is
   * wrong in exactly the case `tooDeep` exists to announce. A reader told the
   * knob was unset never looks at the depth bound.
   */
  available: boolean;
  /**
   * Did the knob name a directory this process could walk?
   *
   * True the moment discovery got somewhere to look, whatever it found there.
   * `configured && !available` is the interesting state - it is "your corpus is
   * set and yielded nothing", and it is the one that has to print WHY.
   */
  configured: boolean;
  /** Absolute corpus root, or null when the knob is unset or unusable. */
  root: string | null;
  entries: CorpusEntry[];
  /** `entries` grouped by format, in discovery order. */
  byFormat: Record<CorpusFormat, CorpusEntry[]>;
  /**
   * Directories the walk could not read, plus whatever it dropped on reaching
   * `MAX_WALK_ENTRIES`. Depth is NOT counted here - see `tooDeep`.
   */
  skipped: number;
  /**
   * Directories not descended into because they sat deeper than
   * `MAX_WALK_DEPTH` levels below the corpus root.
   *
   * DIRECTORIES, not the files inside them: counting those would mean walking
   * them, which is the work the bound exists to refuse. So this is a count of
   * doors not opened, and any non-zero value means the inventory is a lower
   * bound on what the corpus holds.
   *
   * It exists because the alternative to a number is an ABSENCE, and an absence
   * is unreadable: at a walk depth of 8 this integration reported 352 files with
   * total confidence, and nothing in that line distinguished "this is all there
   * is" from "this is all I looked at" - 44 more sat at levels 9 to 11, among
   * them a Walls project whose `.PATH` directives name a dozen surveys. A run
   * that sees less of the corpus than it could is a run whose coverage claim is
   * wrong by an unknown amount. Printed by `describeCorpus` whenever it is
   * non-zero, so the next corpus that outgrows the bound says so on the first
   * line of output rather than in a file count nobody can check.
   */
  tooDeep: number;
  /**
   * Every `id` that more than one entry folds to, sorted.
   *
   * IDS ONLY - listing the paths would be the leak this whole module exists to
   * prevent, and the ids are what a reader sees in the metric keys anyway. An
   * empty array is the normal case; a non-empty one is printed by
   * `describeCorpus` on every run that has it.
   */
  idCollisions: string[];
}

/**
 * Walk bounds. A corpus is somebody's data directory, not a curated tree: it can
 * contain a node_modules, a photo archive or a mounted share, and discovery runs
 * at the start of every fuzz session. So the walk is bounded in two independent
 * ways - how deep it goes, and how much it looks at in total - and it does not
 * follow symlinks, which is also what makes it terminate without a visited set.
 *
 * `MAX_WALK_DEPTH` IS DELIBERATELY THE SAME NUMBER AS `MAX_MATERIALIZED_DEPTH`,
 * and the two are pinned equal by a test. Discovery and materialization are the
 * two halves of one operation - see a file, then copy its tree - so a walk
 * shallower than the copy hides files the copy would have taken happily, and a
 * walk deeper than the copy draws entries every materialization then refuses.
 * Neither half is the interesting one on its own; the pair is.
 *
 * It was 8, and the shallow half is exactly what that cost: measured on the
 * corpus this integration was written for, 8 levels found 352 importable files
 * and 16 finds 396 - the 44 in between including three more Walls project files,
 * one of them 12 `.PATH` directives over a 14-file tree. Nothing reported the
 * gap, because a file that is never discovered leaves no trace anywhere, which
 * is why the depth bound now COUNTS what it refuses (`CorpusInventory.tooDeep`)
 * instead of folding it into the general skip counter. 16 leaves that corpus
 * with five levels of headroom and the counter to say when that stops being
 * true; the entry cap, not the depth, is what bounds the walk's total work.
 *
 * The two depths are measured from different origins and that asymmetry is the
 * safe one: this walk counts levels below the CORPUS ROOT, while `measureTree`
 * counts them below the entry's OWN directory, so every file this walk can see
 * is at depth 0 of its own materialization and can never be refused for being
 * the deep thing itself. (A companion further below it still can be, which is
 * what the `depth` skip reason reports.)
 */
export const MAX_WALK_DEPTH = 16;
const MAX_WALK_ENTRIES = 20000;

/** The corpus root as configured RIGHT NOW, or null. */
export function corpusDir(): string | null {
  const raw = process.env[CORPUS_DIR_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  return path.resolve(raw.trim());
}

/** Is there a usable corpus configured? Never throws - absence is not an error. */
export function corpusAvailable(): boolean {
  const root = corpusDir();
  if (root === null) return false;
  try {
    return fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The publishable identity of a corpus file: CRC-32 of its relative path, folded
 * to the low 20 bits and rendered as 5 hex characters.
 *
 * This exists because the repo's private-fixture rules make the real name
 * unpublishable - a survey filename can name a cave system, a landowner or an
 * unreleased project, and a failure payload, a metric key and a shrunk trace are
 * all things that get attached to an issue.
 *
 * The fold itself lives in `crc32.ts` as `shortId`, because `fuzzTrace.ts` needs
 * the same one: it folds a corpus reference at record time and prints the result
 * for a `corpusFile` step. A trace line naming a different id from the metric
 * key beside it would be worse than having no id at all.
 */
export function corpusFileId(relPath: string): string {
  return shortId(relPath);
}

/**
 * The RESOLUTION identity of a corpus file: 16 hex characters of SHA-256 over
 * its relative path.
 *
 * 64 bits, so a 20000-entry corpus collides with probability around 1e-11 -
 * which is the property `corpusFileId` cannot have and a replay needs. It is
 * one-way in the same sense the crc is (and rather more so), but that is not
 * why it is allowed anywhere: it is allowed because it is never RENDERED. It
 * lives in the `corpusFile` trace step as a lookup key and nowhere else, while
 * every line a human or an issue ever sees still carries `id`.
 *
 * SHA-256 rather than the full CRC-32 the id is folded from: 32 bits is a ~5%
 * collision chance over the same 20000 entries, which is not a resolution key
 * either.
 */
export function corpusPathHash(relPath: string): string {
  return crypto.createHash('sha256').update(relPath, 'utf8').digest('hex').slice(0, 16);
}

function emptyByFormat(): Record<CorpusFormat, CorpusEntry[]> {
  return { dmp: [], tml: [], tmlu: [], dat: [], mak: [], srv: [], wpj: [], gpx: [] };
}

/**
 * Every importable file under the corpus root.
 *
 * Returns an empty inventory when nothing is configured, when the path does not
 * exist, and when it cannot be read: a corpus is optional, so its absence must
 * never be the reason a fuzz run fails.
 */
export function discoverCorpus(): CorpusInventory {
  const root = corpusDir();
  const empty: CorpusInventory = {
    available: false,
    configured: false,
    root: null,
    entries: [],
    byFormat: emptyByFormat(),
    skipped: 0,
    tooDeep: 0,
    idCollisions: [],
  };
  if (root === null || !corpusAvailable()) return empty;

  const entries: CorpusEntry[] = [];
  const byFormat = emptyByFormat();
  let skipped = 0;
  let tooDeep = 0;
  let visited = 0;

  const walk = (dir: string, depth: number): void => {
    // Two bounds, counted apart. Depth is the one a growing corpus hits by
    // simply being organised one folder deeper, and the one whose fix is a
    // number in this file - so it gets its own counter and its own line of
    // output rather than being one more anonymous skip.
    if (depth > MAX_WALK_DEPTH) {
      tooDeep++;
      return;
    }
    if (visited >= MAX_WALK_ENTRIES) {
      skipped++;
      return;
    }
    let listing: fs.Dirent[];
    try {
      listing = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped++;
      return;
    }
    // Sorted, so the inventory (and therefore every `ctx.pick` over it) is the
    // same on every filesystem rather than depending on readdir order.
    for (const item of [...listing].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (visited >= MAX_WALK_ENTRIES) return;
      visited++;
      const absolute = path.join(dir, item.name);
      // Symlinks are not followed: a corpus is somebody's data directory and a
      // link out of it would put the walk somewhere they did not point us.
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        walk(absolute, depth + 1);
        continue;
      }
      if (!item.isFile()) continue;
      const format = FORMAT_BY_EXTENSION[path.extname(item.name).toLowerCase()];
      if (format === undefined) continue;
      let bytes = 0;
      try {
        bytes = fs.statSync(absolute).size;
      } catch {
        skipped++;
        continue;
      }
      const relPath = path.relative(root, absolute).split(path.sep).join('/');
      const entry: CorpusEntry = {
        relPath,
        format,
        id: corpusFileId(relPath),
        pathHash: corpusPathHash(relPath),
        bytes,
      };
      entries.push(entry);
      byFormat[format].push(entry);
    }
  };

  walk(root, 0);

  // Collisions are DETECTED, not assumed away. The old comment on `shortId`
  // said they were "possible and harmless"; they are harmless for telling two
  // files apart in one run's output and not harmless for resolving one, which
  // is what a replay does with the id in a trace.
  const byId = new Map<string, number>();
  for (const entry of entries) byId.set(entry.id, (byId.get(entry.id) ?? 0) + 1);
  const idCollisions = [...byId.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();

  return {
    available: entries.length > 0,
    configured: true,
    root,
    entries,
    byFormat,
    skipped,
    tooDeep,
    idCollisions,
  };
}

/** What a lookup did. `ambiguous` is a crc20 collision and is never a guess. */
export type CorpusLookupOutcome = 'found' | 'missing' | 'ambiguous';

export interface CorpusLookup {
  outcome: CorpusLookupOutcome;
  entry: CorpusEntry | null;
  /** How many entries matched. 0 for a miss, >1 for an ambiguous id. */
  matches: number;
}

const HASH_RE = /^[0-9a-f]{16}$/;
const ID_RE = /^[0-9a-f]{5}$/;

/**
 * Resolve one entry from a relative path, a `pathHash`, or a bare `id`.
 *
 * Three key spaces, one function, because the callers hold different halves. A
 * LIVE run drew the entry from the inventory and holds its path. A REPLAY holds
 * only what a trace is allowed to carry: since schema v4 that is the `pathHash`
 * plus the publishable `id`, and it resolves against whatever corpus the
 * REPLAYER configured. The spaces cannot be confused - a hash is 16 bare hex
 * characters, an id is 5, and every relative path this module yields ends in one
 * of the importable extensions above, so none can be read as either.
 *
 * THE `ambiguous` OUTCOME IS THE POINT. A bare id is 20 bits, and a corpus of a
 * few thousand files probably holds a colliding pair; `find`-ing the first match
 * would materialize the wrong private file and then open it under the recorded
 * file's name. So a bare id that matches more than one entry resolves to
 * NOTHING, and the caller counts it - a narrower replay, never a wrong one.
 * A `pathHash` does not have that problem and is what a v4 trace prefers.
 *
 * A miss is not an error either. A trace recorded against somebody else's
 * corpus - or on a machine that has one at all - is replayed by skipping those
 * moves and counting them.
 */
export function corpusLookup(reference: string): CorpusLookup {
  const entries = discoverCorpus().entries;
  const key: (entry: CorpusEntry) => string = HASH_RE.test(reference)
    ? (entry) => entry.pathHash
    : ID_RE.test(reference)
      ? (entry) => entry.id
      : (entry) => entry.relPath;
  const matches = entries.filter((entry) => key(entry) === reference);
  if (matches.length === 1) return { outcome: 'found', entry: matches[0], matches: 1 };
  if (matches.length === 0) return { outcome: 'missing', entry: null, matches: 0 };
  return { outcome: 'ambiguous', entry: null, matches: matches.length };
}

/**
 * `corpusLookup` reduced to "the entry, or nothing".
 *
 * Kept for the callers that treat every non-resolution the same way. Anything
 * that wants to tell an ambiguous id apart from an absent one - which is worth
 * a distinct metric, because the two say different things about the corpus -
 * should call `corpusLookup` directly.
 */
export function corpusEntryFor(reference: string): CorpusEntry | null {
  return corpusLookup(reference).entry;
}

/**
 * Bounds on a single materialization.
 *
 * The unit is a DIRECTORY TREE, not a file (see below), so the bounds are on the
 * tree: one folder holding a decade of dive logs is not something to copy once
 * per fuzz iteration. Measured against the real corpus this was built for, the
 * largest Walls project tree is 275 files / 28 MB / 9 levels deep, so all three
 * bounds clear it with room and none of them is tuned to it.
 *
 * Exceeding any bound copies NOTHING and says which bound it was. A partial copy
 * would be the worst outcome available: the import would fail on a missing
 * companion and the run would record that as the app's answer to a real project.
 *
 * `MAX_MATERIALIZED_DEPTH` and `MAX_WALK_DEPTH` are the same number on purpose,
 * and a test pins them equal; the reasoning lives on `MAX_WALK_DEPTH`, because
 * the failure the pairing prevents is a discovery-side one.
 */
export const MAX_MATERIALIZED_BYTES = 64 * 1024 * 1024;
export const MAX_MATERIALIZED_FILES = 4000;
export const MAX_MATERIALIZED_DEPTH = 16;

/** Which bound stopped a materialization, or what went wrong instead. */
export type MaterializeSkip = 'bytes' | 'files' | 'depth' | 'io';

export interface MaterializedCorpusEntry {
  /** Path of the entry file inside `destDir`. Hand THIS to the app. Empty on a skip. */
  path: string;
  /** Files copied alongside it, at any depth. */
  copied: number;
  bytes: number;
  /** True when a bound was exceeded or a copy failed, and NOTHING was copied. */
  skipped: boolean;
  /** Why. Null when `skipped` is false. */
  reason: MaterializeSkip | null;
  /**
   * Every distinct path SEGMENT the copy created under `destDir` - file
   * basenames and directory names alike, at any depth.
   *
   * The caller needs it for redaction: `importDialogFuzz.ts` rewrites each of
   * these out of a failure payload, and a nested companion's directory name can
   * identify a cave system exactly as well as a file's can. Returning the list
   * is what keeps that caller from having to re-walk the tree it just wrote.
   */
  names: string[];
}

interface TreeMeasurement {
  /** POSIX-relative paths under the source directory, sorted. */
  files: { rel: string; size: number }[];
  bytes: number;
  skip: MaterializeSkip | null;
}

/**
 * Measure the tree before copying any of it, so a bound is a decision rather
 * than a place the copy stopped.
 *
 * Symlinks are skipped at every level, files and directories alike, for the same
 * reason the discovery walk does not follow them: a link can point outside the
 * directory the caller meant to copy. That is also what makes the recursion
 * terminate without a visited set.
 */
function measureTree(sourceDir: string): TreeMeasurement {
  const files: { rel: string; size: number }[] = [];
  let bytes = 0;
  let skip: MaterializeSkip | null = null;

  const walk = (dir: string, prefix: string, depth: number): void => {
    if (skip !== null) return;
    if (depth > MAX_MATERIALIZED_DEPTH) {
      skip = 'depth';
      return;
    }
    let listing: fs.Dirent[];
    try {
      listing = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skip = 'io';
      return;
    }
    for (const item of [...listing].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (skip !== null) return;
      if (item.isSymbolicLink()) continue;
      const absolute = path.join(dir, item.name);
      const rel = prefix === '' ? item.name : `${prefix}/${item.name}`;
      if (item.isDirectory()) {
        walk(absolute, rel, depth + 1);
        continue;
      }
      if (!item.isFile()) continue;
      let size = 0;
      try {
        size = fs.statSync(absolute).size;
      } catch {
        skip = 'io';
        return;
      }
      files.push({ rel, size });
      bytes += size;
      if (files.length > MAX_MATERIALIZED_FILES) skip = 'files';
      else if (bytes > MAX_MATERIALIZED_BYTES) skip = 'bytes';
    }
  };

  walk(sourceDir, '', 0);
  return { files, bytes, skip };
}

/**
 * Copy an entry's CONTAINING DIRECTORY - the whole tree below it, structure
 * preserved - into `destDir`, and return the copied entry's path.
 *
 * The directory rather than the file, because two of these formats are not one
 * file: a Compass `.mak` names `.dat` survey files by relative path, and a Walls
 * `.wpj` names a tree of `.srv`. Copying the `.mak` alone produces an import
 * failure that says nothing about the app - it says the harness took half a
 * project.
 *
 * AND THE WHOLE TREE, not just the immediate children, because both of those
 * relative paths can descend. Walls `.PATH` directives are exactly that: a
 * project file that names a subfolder and then lists the surveys inside it.
 * Measured on the corpus this integration was written for, the two `.wpj`
 * projects that use `.PATH` name 127 and 12 of them, ALL of them below the
 * project's own directory, and an immediate-children copy took 1 file of 275 and
 * 1 of 14. So those two corpus cases were not exercising the Walls importer at
 * all - they were exercising its missing-file handling, and reporting it as
 * coverage of a real project.
 *
 * The copy is what the app is pointed at, always. An import can migrate a file
 * in place, and a corpus is unversioned data somebody would not get back.
 *
 * EVERY file is copied, not just the importable extensions. That costs a little
 * I/O on a directory holding unrelated files, and it buys correctness on the
 * formats that reference companions this module has no catalog for - a Compass
 * project can name a `.clp` closure file, and a whitelist would silently drop it
 * and turn a real parse into a fake one. The bounds are what keep the cost
 * bounded instead.
 *
 * ALL OR NOTHING. A tree over any bound copies nothing and reports which bound;
 * a copy that fails part-way is UNDONE and reported as `io`. A half-copied
 * project is indistinguishable from a corrupt one from inside the app, and the
 * fuzzer would file the difference against the importer.
 */
export function materializeCorpusEntry(
  entry: CorpusEntry,
  destDir: string,
): MaterializedCorpusEntry {
  const root = corpusDir();
  if (root === null) throw new Error(`${CORPUS_DIR_ENV} is not set; nothing to materialize`);

  const sourceDir = path.dirname(path.join(root, entry.relPath));
  try {
    if (!fs.statSync(sourceDir).isDirectory()) {
      throw new Error('not a directory');
    }
  } catch (err) {
    // The ERRNO CODE, never the message. Node builds an fs error message out of
    // the full path it tried - `ENOENT: no such file or directory, stat
    // '/home/.../<a real cave name>/...'` - and this throw is not caught by
    // `sourceOnDisk`, so it escapes into the scenario's failure payload BEFORE
    // any redaction for this entry has been registered, and from there into the
    // printed detail and the campaign report. The id is the publishable name for
    // exactly this reason; the code says what went wrong without saying where.
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(`corpus entry ${entry.id} is not readable (${code ?? 'io'})`);
  }

  const measured = measureTree(sourceDir);
  if (measured.skip !== null) {
    return { path: '', copied: 0, bytes: measured.bytes, skipped: true, reason: measured.skip, names: [] };
  }

  // Only the entries THIS call creates are removable on an abort, so a caller
  // that pointed two materializations at one directory cannot lose the first.
  const createdTop: string[] = [];
  const names = new Set<string>();
  const existedBefore = fs.existsSync(destDir);
  fs.mkdirSync(destDir, { recursive: true });

  let copied = 0;
  let bytes = 0;
  try {
    for (const file of measured.files) {
      const segments = file.rel.split('/');
      for (const segment of segments) names.add(segment);
      if (segments.length > 1) {
        const top = segments[0];
        if (!createdTop.includes(top) && !fs.existsSync(path.join(destDir, top))) createdTop.push(top);
        fs.mkdirSync(path.dirname(path.join(destDir, ...segments)), { recursive: true });
      } else if (!createdTop.includes(file.rel)) {
        createdTop.push(file.rel);
      }
      fs.copyFileSync(path.join(sourceDir, ...segments), path.join(destDir, ...segments));
      copied++;
      bytes += file.size;
    }
  } catch {
    if (existedBefore) {
      for (const top of createdTop) fs.rmSync(path.join(destDir, top), { recursive: true, force: true });
    } else {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    return { path: '', copied: 0, bytes: 0, skipped: true, reason: 'io', names: [] };
  }

  return {
    path: path.join(destDir, path.basename(entry.relPath)),
    copied,
    bytes,
    skipped: false,
    reason: null,
    names: [...names].sort(),
  };
}

/**
 * One line a run can print without naming anything private.
 *
 * A crc20 collision is called out here rather than buried in a metric, because
 * it changes how the run's own output reads: two files share a metric key and a
 * log tag, and a trace recorded now can only be replayed through the `pathHash`.
 * The colliding IDS are named and the paths are not, which is the same rule as
 * everywhere else in this module.
 *
 * A depth refusal is called out for the same kind of reason and a stronger one:
 * it makes the file count on this very line a LOWER BOUND, so a reader who is
 * not told cannot interpret the number they were given.
 */
export function describeCorpus(inventory: CorpusInventory): string {
  // Gated on `configured`, NOT on `available`. A corpus that was walked and
  // yielded nothing still has to report why it yielded nothing, and the depth
  // note below is the whole reason `tooDeep` is counted separately: the case it
  // was built for - every importable file one level too deep - is precisely the
  // case that produces zero entries, so an `available` gate here made the
  // warning unreachable exactly when it was needed.
  if (!inventory.configured) return `corpus: none (${CORPUS_DIR_ENV} unset, missing or unreadable)`;
  const counts = (Object.keys(inventory.byFormat) as CorpusFormat[])
    .filter((format) => inventory.byFormat[format].length > 0)
    .map((format) => `${format}=${inventory.byFormat[format].length}`)
    .join(' ');
  const formats = counts === '' ? 'no importable format' : counts;
  const notes: string[] = [];
  if (inventory.skipped > 0) notes.push(`${inventory.skipped} dir(s) skipped`);
  if (inventory.tooDeep > 0) {
    notes.push(
      `${inventory.tooDeep} dir(s) deeper than ${MAX_WALK_DEPTH} levels NOT searched - ` +
        'this count is a lower bound',
    );
  }
  return (
    `corpus: ${inventory.entries.length} file(s) [${formats}]` +
    (notes.length > 0 ? ` (${notes.join('; ')})` : '') +
    (inventory.idCollisions.length > 0
      ? ` WARNING: ${inventory.idCollisions.length} crc20 id(s) name more than one file ` +
        `[${inventory.idCollisions.join(',')}]; those ids are ambiguous in metric keys and ` +
        `resolve to nothing on replay - a trace's pathHash is what resolves them`
      : '')
  );
}
