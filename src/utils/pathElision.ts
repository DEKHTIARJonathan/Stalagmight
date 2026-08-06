/**
 * Path elision: produce a list of progressively shorter renderings of a file
 * path, ordered longest → shortest, so a caller can measure each against an
 * available width and pick the widest that fits.
 *
 * Elision scheme (matches the agreed UX):
 *   1. full path
 *   2. leading folder segments abbreviated to a single letter, left → right
 *      (the filename - the last segment - is never abbreviated)
 *   3. if still too long, middle-truncate with `…`, dropping interior folders
 *      while keeping the filename whole
 *
 * Example for `/home/user/surveys/orda/main-line/spring.stalx`:
 *   /home/user/surveys/orda/main-line/spring.stalx
 *   /h/user/surveys/orda/main-line/spring.stalx
 *   …
 *   /h/u/s/o/m/spring.stalx
 *   /h/u/s/o/…/spring.stalx
 *   …
 *   /…/spring.stalx
 *
 * Windows-rooted paths (a `C:` drive or a `\\server\share` UNC root) skip step
 * 2: the root is kept verbatim, `\` is used throughout however the path was
 * stored, and interior folders are dropped straight away. A deep path elides to
 * `C:\…\work\spring.stalx` instead of a run of single letters that is neither a
 * valid path nor enough to tell two same-named projects apart.
 */

const ELLIPSIS = '…';

/** `C:\` or `C:/` - the drive is a root, not an abbreviatable segment. */
const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;
/** `\\server\share` - host and share are both part of the root. */
const UNC_PREFIX = /^\\\\/;

interface SplitPath {
  /** Root rendered verbatim, trailing separator included (may be empty). */
  prefix: string;
  sep: string;
  /** Segments below the root, empty ones dropped. */
  parts: string[];
  /** Windows root: middle-truncate rather than abbreviate segments. */
  windowsRoot: boolean;
}

/** Pick the separator the path uses (Windows backslash vs POSIX slash). */
function detectSeparator(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

/** First visible character of a folder name, used as its abbreviation. */
function abbreviate(segment: string): string {
  return segment.slice(0, 1);
}

/** Split on either separator - Windows accepts (and stores) both. */
function splitEither(rest: string): string[] {
  return rest.split(/[\\/]+/).filter((p) => p.length > 0);
}

/** Separate the root that must survive elision from the segments below it. */
function splitPath(path: string): SplitPath {
  if (UNC_PREFIX.test(path)) {
    const parts = splitEither(path.slice(2));
    const root = parts.splice(0, 2);
    return { prefix: `\\\\${root.join('\\')}\\`, sep: '\\', parts, windowsRoot: true };
  }

  if (DRIVE_PREFIX.test(path)) {
    return {
      prefix: `${path.slice(0, 2)}\\`,
      sep: '\\',
      parts: splitEither(path.slice(2)),
      windowsRoot: true,
    };
  }

  const sep = detectSeparator(path);
  return {
    prefix: path.startsWith(sep) ? sep : '',
    sep,
    parts: path.split(sep).filter((p) => p.length > 0),
    windowsRoot: false,
  };
}

/**
 * Returns path renderings from longest (full) to shortest, with no consecutive
 * duplicates. Always returns at least one element. Single-segment paths (a bare
 * filename) and empty input are returned unchanged with nothing to elide.
 */
export function pathElisionCandidates(path: string): string[] {
  if (!path) return [''];

  const { prefix, sep, parts, windowsRoot } = splitPath(path);
  const join = (segments: string[]): string => prefix + segments.join(sep);

  // Windows roots are re-rendered with `\`; other paths are shown as stored.
  const full = windowsRoot ? join(parts) : path;

  // Nothing to elide: just a filename (optionally rooted).
  if (parts.length <= 1) return [full];

  const filename = parts[parts.length - 1] as string;
  const folders = parts.slice(0, -1);

  const candidates: string[] = [full];

  if (windowsRoot) {
    // Middle-truncate only: keep the root, the last k folders and the (whole)
    // filename. k counts down so each step is shorter than the last.
    for (let k = folders.length - 1; k >= 0; k--) {
      candidates.push(join([ELLIPSIS, ...folders.slice(folders.length - k), filename]));
    }
  } else {
    // Abbreviate leading folders one at a time, left → right.
    const abbrev = [...folders];
    for (let i = 0; i < folders.length; i++) {
      abbrev[i] = abbreviate(folders[i] as string);
      candidates.push(join([...abbrev, filename]));
    }

    // Middle-truncate: keep the first k abbreviated folders, then `…`, then the
    // (whole) filename. k counts down so each step is shorter than the last.
    for (let k = folders.length - 1; k >= 0; k--) {
      candidates.push(join([...abbrev.slice(0, k), ELLIPSIS, filename]));
    }
  }

  // Drop consecutive duplicates (e.g. already-single-char folders).
  return candidates.filter((c, i) => i === 0 || c !== candidates[i - 1]);
}
