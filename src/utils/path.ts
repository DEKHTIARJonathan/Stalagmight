/**
 * Extract filename from a path, optionally stripping an extension.
 * Works with both forward slashes and backslashes (cross-platform).
 */
export function extractFilename(path: string, stripExtension?: RegExp): string {
  const name = path.split(/[/\\]/).pop() ?? path;
  return stripExtension ? name.replace(stripExtension, '') : name;
}

/**
 * True for a path in Windows shape: a drive letter followed by a separator
 * (`C:\caves`, `C:/caves`), or a leading `\\` (a network path `\\srv\share`, or a
 * verbatim path `\\?\C:\caves`). Only such a path treats `\` as a separator: on
 * Linux and macOS `\` is an ordinary file-name character.
 */
export function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[/\\]/.test(path) || path.startsWith('\\\\');
}

/** Index of the separator before the file name, or -1 (see {@link isWindowsPath}). */
function lastSeparatorIndex(path: string): number {
  const slash = path.lastIndexOf('/');
  return isWindowsPath(path) ? Math.max(slash, path.lastIndexOf('\\')) : slash;
}

/**
 * The folder holding `path`, without the separator before the file name:
 * `/home/u/caves` for `/home/u/caves/CaveA.stalx`, `C:\caves` for
 * `C:\caves\CaveA.stalx`. A Windows drive root keeps its separator (`C:\`), since
 * a bare `C:` means the current directory on drive C. A POSIX path is split on
 * `/` alone, so a file directly under `/`, or a bare file name, gives ''.
 */
export function parentDir(path: string): string {
  const at = lastSeparatorIndex(path);
  const dir = path.substring(0, at);
  return /^[a-zA-Z]:$/.test(dir) ? path.substring(0, at + 1) : dir;
}

/**
 * The file `name` in the folder holding `path`, joined with the separator that
 * precedes `path`'s own file name: `C:\caves\CaveB.stalx` next to
 * `C:\caves\CaveA.stalx`. A POSIX path is split on `/` alone and always joined
 * with `/`, so a bare file name gives `/name`.
 */
export function siblingPath(path: string, name: string): string {
  const at = lastSeparatorIndex(path);
  return `${path.substring(0, at)}${path[at] ?? '/'}${name}`;
}
