import type { ProjectMetadata } from '../../types/project';

/**
 * A row in the recent-projects list: either an available project (full
 * metadata) or a recent path whose file could not be loaded (missing/moved/
 * unreadable). Missing entries are derived on the frontend — the backend
 * silently drops unreadable paths from the metadata list, but the config keeps
 * every recent path, so the difference is the set of unavailable projects.
 */
export type RecentListItem =
  | { kind: 'available'; filePath: string; project: ProjectMetadata }
  | { kind: 'missing'; filePath: string; name: string };

/** Last path segment (filename with extension), for naming missing entries. */
export function fileNameFromPath(path: string): string {
  const parts = path.split(/[/\\]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

/**
 * Recent paths that have no loaded metadata (file missing, moved, or
 * unreadable), preserving the order they appear in the config (most-recently
 * opened first).
 */
export function deriveMissingPaths(
  recentPaths: string[],
  available: Pick<ProjectMetadata, 'file_path'>[]
): string[] {
  const have = new Set(available.map((p) => p.file_path));
  return recentPaths.filter((p) => !have.has(p));
}

/**
 * Build the combined list of rows: available projects first (already sorted by
 * the caller), then unavailable ones appended in config order. Missing entries
 * lack metadata, so they cannot participate in metadata-based sorting.
 */
export function buildRecentListItems(
  sortedAvailable: ProjectMetadata[],
  missingPaths: string[]
): RecentListItem[] {
  const available: RecentListItem[] = sortedAvailable.map((project) => ({
    kind: 'available',
    filePath: project.file_path,
    project,
  }));
  const missing: RecentListItem[] = missingPaths.map((filePath) => ({
    kind: 'missing',
    filePath,
    name: fileNameFromPath(filePath),
  }));
  return [...available, ...missing];
}

/**
 * Case-insensitive filter over name, location, and path. Available rows match
 * on any of the three; missing rows match on name or path. An empty/whitespace
 * term returns the list unchanged.
 */
export function filterRecentListItems(
  items: RecentListItem[],
  term: string
): RecentListItem[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => {
    if (item.kind === 'available') {
      const { name, location, file_path } = item.project;
      return (
        name.toLowerCase().includes(needle) ||
        (location?.toLowerCase().includes(needle) ?? false) ||
        file_path.toLowerCase().includes(needle)
      );
    }
    return (
      item.name.toLowerCase().includes(needle) ||
      item.filePath.toLowerCase().includes(needle)
    );
  });
}
