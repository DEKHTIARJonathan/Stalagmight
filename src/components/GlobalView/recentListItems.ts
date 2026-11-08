import type { ProjectMetadata } from '../../types/project';
import type { SpeleoProjectSummary } from '../../types/ipc.generated';

/** Local projects, unavailable local paths, and SpeleoDB projects.
 * Every SpeleoDB project is remote here, regardless of whether it has a cached copy.
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
  // Managed cache files are represented by their remote project, never by local
  // missing-file actions. Their cache path is fixed by the backend.
  const managedCache = /[/\\]speleodb[/\\][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[/\\]project\.stalx$/i;
  return recentPaths.filter((p) => !have.has(p) && !managedCache.test(p));
}

/** All SpeleoDB projects use the same remote entry, including cached projects.
 * A cached name keeps the project discoverable when the startup refresh is offline;
 * permission and lock state stay unknown until the server answers.
 */
export function remoteSummaryForProject(
  project: ProjectMetadata,
  summaries: Record<string, SpeleoProjectSummary>,
): SpeleoProjectSummary | null {
  if (!project.is_remote || !project.speleodb_project_id) return null;
  return summaries[project.speleodb_project_id] ?? {
    id: project.speleodb_project_id,
    name: project.name,
    permission: null,
    lock_holder: null,
    type_tag: 'stalx',
    latest_commit_sha: null,
  };
}

export function deriveRemoteItems(
  summaries: Record<string, SpeleoProjectSummary>,
  available: ProjectMetadata[],
): RecentListItem[] {
  const projects = new Map(Object.values(summaries).map((s) => [s.id, s]));
  for (const project of available) {
    const summary = remoteSummaryForProject(project, summaries);
    if (summary && !projects.has(summary.id)) projects.set(summary.id, summary);
  }
  return [...projects.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((summary) => ({ kind: 'remote', projectId: summary.id, summary }));
}

/**
 * Build the combined list of rows: available local projects first (already sorted
 * by the caller), then remote SpeleoDB projects (#218), then unavailable
 * (missing) paths in config order. Missing + remote entries lack local metadata,
 * so they cannot participate in metadata-based sorting.
 */
export function buildRecentListItems(
  sortedAvailable: ProjectMetadata[],
  missingPaths: string[],
  remoteItems: RecentListItem[] = []
): RecentListItem[] {
  const available: RecentListItem[] = sortedAvailable.filter((project) => !project.is_remote).map((project) => ({
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
