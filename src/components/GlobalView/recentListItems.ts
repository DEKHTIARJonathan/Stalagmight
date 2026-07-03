import type { ProjectMetadata } from '../../types/project';
import type { SpeleoProjectSummary } from '../../types/ipc.generated';

/**
 * A row in the recent-projects list: an available local project (full
 * metadata), a recent path whose file could not be loaded (missing/moved/
 * unreadable), or a purely-remote SpeleoDB project (#218) the user can access
 * on the server but hasn't pulled locally yet. Missing entries are derived on
 * the frontend — the backend silently drops unreadable paths from the metadata
 * list, but the config keeps every recent path, so the difference is the set of
 * unavailable projects. Remote entries come from the lock-scan summaries and
 * carry no local file (Open pulls them, like the browser dialog).
 */
export type RecentListItem =
  | { kind: 'available'; filePath: string; project: ProjectMetadata }
  | { kind: 'missing'; filePath: string; name: string }
  | { kind: 'remote'; projectId: string; summary: SpeleoProjectSummary };

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
 * Purely-remote SpeleoDB projects (#218): accessible on the server but not among
 * the local recents. A local recent that is already linked to a SpeleoDB project
 * (its `speleodb_project_id` matches a summary id) is excluded, so it is never
 * listed twice - the local badge already covers it. Ordered by name for a stable,
 * scan-order-independent list. `summaries` is the store's `remoteSummaries` map.
 */
export function deriveRemoteOnlyItems(
  summaries: Record<string, SpeleoProjectSummary>,
  available: Pick<ProjectMetadata, 'speleodb_project_id'>[]
): RecentListItem[] {
  const linked = new Set(
    available.map((p) => p.speleodb_project_id).filter((id): id is string => !!id)
  );
  return Object.values(summaries)
    .filter((s) => !linked.has(s.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((summary) => ({ kind: 'remote', projectId: summary.id, summary }));
}

/**
 * Build the combined list of rows: available local projects first (already sorted
 * by the caller), then purely-remote SpeleoDB projects (#218), then unavailable
 * (missing) paths in config order. Missing + remote entries lack local metadata,
 * so they cannot participate in metadata-based sorting.
 */
export function buildRecentListItems(
  sortedAvailable: ProjectMetadata[],
  missingPaths: string[],
  remoteItems: RecentListItem[] = []
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
  return [...available, ...remoteItems, ...missing];
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
    if (item.kind === 'remote') {
      return item.summary.name.toLowerCase().includes(needle);
    }
    return (
      item.name.toLowerCase().includes(needle) ||
      item.filePath.toLowerCase().includes(needle)
    );
  });
}
