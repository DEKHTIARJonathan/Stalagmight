/**
 * Extract filename from a path, optionally stripping an extension.
 * Works with both forward slashes and backslashes (cross-platform).
 */
export function extractFilename(path: string, stripExtension?: RegExp): string {
  const name = path.split(/[/\\]/).pop() ?? path;
  return stripExtension ? name.replace(stripExtension, '') : name;
}
