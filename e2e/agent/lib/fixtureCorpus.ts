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
 *     key or a log line carries. The real name never leaves this module;
 *   - the app is only ever pointed at a COPY, so an import that migrates or
 *     rewrites a file cannot touch the original.
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
  /** POSIX-style path relative to the corpus root. Never logged; see `id`. */
  relPath: string;
  format: CorpusFormat;
  /** The publishable stand-in for `relPath`. */
  id: string;
  /** Size in bytes, so a caller can skip what it does not want to open. */
  bytes: number;
}

export interface CorpusInventory {
  available: boolean;
  /** Absolute corpus root, or null when the knob is unset or unusable. */
  root: string | null;
  entries: CorpusEntry[];
  /** `entries` grouped by format, in discovery order. */
  byFormat: Record<CorpusFormat, CorpusEntry[]>;
  /** Directories skipped by the walk bounds, so a thin inventory is explicable. */
  skipped: number;
}

/**
 * Walk bounds. A corpus is somebody's data directory, not a curated tree: it can
 * contain a node_modules, a photo archive or a mounted share, and discovery runs
 * at the start of every fuzz session.
 */
const MAX_WALK_DEPTH = 8;
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
 * The fold itself lives in `crc32.ts` as `shortId`, because
 * `fuzzTrace.describeSteps` prints the same tag for a `corpusFile` step: a trace
 * line naming a different id from the metric key beside it would be worse than
 * having no id at all.
 */
export function corpusFileId(relPath: string): string {
  return shortId(relPath);
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
    root: null,
    entries: [],
    byFormat: emptyByFormat(),
    skipped: 0,
  };
  if (root === null || !corpusAvailable()) return empty;

  const entries: CorpusEntry[] = [];
  const byFormat = emptyByFormat();
  let skipped = 0;
  let visited = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || visited >= MAX_WALK_ENTRIES) {
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
      const entry: CorpusEntry = { relPath, format, id: corpusFileId(relPath), bytes };
      entries.push(entry);
      byFormat[format].push(entry);
    }
  };

  walk(root, 0);
  return { available: entries.length > 0, root, entries, byFormat, skipped };
}

/** Look one entry up by its relative path - the shape a trace replays from. */
export function corpusEntryFor(relPath: string): CorpusEntry | null {
  return discoverCorpus().entries.find((entry) => entry.relPath === relPath) ?? null;
}

/**
 * Most a single materialization may copy.
 *
 * The unit is a DIRECTORY, not a file (see below), so the bound is on the
 * directory: one folder holding a decade of dive logs is not something to copy
 * once per fuzz iteration.
 */
export const MAX_MATERIALIZED_BYTES = 64 * 1024 * 1024;

export interface MaterializedCorpusEntry {
  /** Path of the entry file inside `destDir`. Hand THIS to the app. */
  path: string;
  /** Files copied alongside it. */
  copied: number;
  bytes: number;
  /** True when the directory exceeded the bound and nothing was copied. */
  skipped: boolean;
}

/**
 * Copy an entry's CONTAINING DIRECTORY into `destDir` and return the copied
 * entry's path.
 *
 * The directory rather than the file, because two of these formats are not one
 * file: a Compass `.mak` names sibling `.dat` survey files by relative path, and
 * a Walls `.wpj` names a tree of `.srv`. Copying the `.mak` alone produces an
 * import failure that says nothing about the app - it says the harness took half
 * a project.
 *
 * The copy is what the app is pointed at, always. An import can migrate a file
 * in place, and a corpus is unversioned data somebody would not get back.
 *
 * EVERY file in the directory is copied, not just the importable extensions.
 * That costs a little I/O on a directory holding unrelated files, and it buys
 * correctness on the formats that reference companions this module has no
 * catalog for - a Compass project can name a `.clp` closure file, and a
 * whitelist would silently drop it and turn a real parse into a fake one. The
 * directory-size bound is what keeps the cost bounded instead.
 *
 * Symlinked siblings are skipped, for the same reason the walk does not follow
 * them: a link can point outside the directory the caller meant to copy.
 */
export function materializeCorpusEntry(
  entry: CorpusEntry,
  destDir: string,
): MaterializedCorpusEntry {
  const root = corpusDir();
  if (root === null) throw new Error(`${CORPUS_DIR_ENV} is not set; nothing to materialize`);

  const sourceDir = path.dirname(path.join(root, entry.relPath));
  let listing: fs.Dirent[];
  try {
    listing = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`corpus entry ${entry.id} is not readable: ${(err as Error).message}`);
  }

  const files = listing
    .filter((item) => item.isFile() && !item.isSymbolicLink())
    .map((item) => item.name)
    .sort();

  let total = 0;
  const sizes = new Map<string, number>();
  for (const name of files) {
    try {
      const size = fs.statSync(path.join(sourceDir, name)).size;
      sizes.set(name, size);
      total += size;
    } catch {
      // Unreadable sibling: it simply is not part of this materialization.
    }
  }
  if (total > MAX_MATERIALIZED_BYTES) {
    return { path: '', copied: 0, bytes: total, skipped: true };
  }

  fs.mkdirSync(destDir, { recursive: true });
  let copied = 0;
  let bytes = 0;
  for (const [name, size] of sizes) {
    try {
      fs.copyFileSync(path.join(sourceDir, name), path.join(destDir, name));
      copied++;
      bytes += size;
    } catch {
      // A file that vanished or is locked is not a reason to abandon the rest.
    }
  }

  return { path: path.join(destDir, path.basename(entry.relPath)), copied, bytes, skipped: false };
}

/** One line a run can print without naming anything private. */
export function describeCorpus(inventory: CorpusInventory): string {
  if (!inventory.available) return `corpus: none (${CORPUS_DIR_ENV} unset or empty)`;
  const counts = (Object.keys(inventory.byFormat) as CorpusFormat[])
    .filter((format) => inventory.byFormat[format].length > 0)
    .map((format) => `${format}=${inventory.byFormat[format].length}`)
    .join(' ');
  return `corpus: ${inventory.entries.length} file(s) [${counts}]${
    inventory.skipped > 0 ? ` (${inventory.skipped} dir(s) skipped)` : ''
  }`;
}
