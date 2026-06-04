/**
 * Path elision: produce a list of progressively shorter renderings of a file
 * path, ordered longest → shortest, so a caller can measure each against an
 * available width and pick the widest that fits.
 *
 * Elision scheme (matches the agreed UX):
 *   1. full path
 *   2. leading folder segments abbreviated to a single letter, left → right
 *      (the filename — the last segment — is never abbreviated)
 *   3. if still too long, middle-truncate with `…`, dropping interior folders
 *      while keeping the filename whole
 *
 * Example for `/home/daniel/surveys/orda/main-line/spring.stalx`:
 *   /home/daniel/surveys/orda/main-line/spring.stalx
 *   /h/daniel/surveys/orda/main-line/spring.stalx
 *   …
 *   /h/d/s/o/m/spring.stalx
 *   /h/d/s/o/…/spring.stalx
 *   …
 *   /…/spring.stalx
 */

const ELLIPSIS = '…';

/** Pick the separator the path uses (Windows backslash vs POSIX slash). */
function detectSeparator(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

/** First visible character of a folder name, used as its abbreviation. */
function abbreviate(segment: string): string {
  return segment.slice(0, 1);
}

/**
 * Returns path renderings from longest (full) to shortest, with no consecutive
 * duplicates. Always returns at least one element. Single-segment paths (a bare
 * filename) and empty input are returned unchanged with nothing to elide.
 */
export function pathElisionCandidates(path: string): string[] {
  if (!path) return [''];

  const sep = detectSeparator(path);
  const leading = path.startsWith(sep) ? sep : '';
  const trimmed = leading ? path.slice(sep.length) : path;
  const parts = trimmed.split(sep).filter((p) => p.length > 0);

  // Nothing to elide: just a filename (optionally rooted).
  if (parts.length <= 1) return [path];

  const filename = parts[parts.length - 1] as string;
  const folders = parts.slice(0, -1);

  const join = (segments: string[]): string => leading + segments.join(sep);

  const candidates: string[] = [path];

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

  // Drop consecutive duplicates (e.g. already-single-char folders).
  return candidates.filter((c, i) => i === 0 || c !== candidates[i - 1]);
}
