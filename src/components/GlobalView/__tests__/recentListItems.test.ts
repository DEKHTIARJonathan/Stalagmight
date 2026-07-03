import { describe, it, expect } from 'vitest';
import {
  fileNameFromPath,
  deriveMissingPaths,
  deriveRemoteOnlyItems,
  buildRecentListItems,
  filterRecentListItems,
  type RecentListItem,
} from '../recentListItems';
import type { ProjectMetadata } from '../../../types/project';
import type { SpeleoProjectSummary } from '../../../types/ipc.generated';

function summary(partial: Partial<SpeleoProjectSummary> & { id: string }): SpeleoProjectSummary {
  return {
    name: `Project ${partial.id}`,
    permission: 'READ_AND_WRITE',
    lock_holder: null,
    type_tag: 'stalx',
    latest_commit_sha: null,
    ...partial,
  } as SpeleoProjectSummary;
}

function project(partial: Partial<ProjectMetadata> & { file_path: string }): ProjectMetadata {
  return {
    name: 'Project',
    location: null,
    modified_at: '2026-01-01T00:00:00Z',
    section_count: 0,
    total_length: 0,
    station_count: 0,
    gps_center: null,
    gps_bounds: null,
    collab_enabled: false,
    ...partial,
  } as ProjectMetadata;
}

describe('fileNameFromPath', () => {
  it('returns the last path segment', () => {
    expect(fileNameFromPath('/home/user/caves/spring.stalx')).toBe('spring.stalx');
    expect(fileNameFromPath('C:\\caves\\spring.stalx')).toBe('spring.stalx');
    expect(fileNameFromPath('spring.stalx')).toBe('spring.stalx');
  });
});

describe('deriveMissingPaths', () => {
  it('returns config paths that have no loaded metadata, in config order', () => {
    const recentPaths = ['/a', '/gone', '/b', '/also-gone'];
    const available = [project({ file_path: '/a' }), project({ file_path: '/b' })];
    expect(deriveMissingPaths(recentPaths, available)).toEqual(['/gone', '/also-gone']);
  });

  it('returns nothing when all paths are available', () => {
    const available = [project({ file_path: '/a' })];
    expect(deriveMissingPaths(['/a'], available)).toEqual([]);
  });
});

describe('deriveRemoteOnlyItems', () => {
  it('keeps remotes not linked to any local recent, sorted by name', () => {
    const summaries = {
      p2: summary({ id: 'p2', name: 'Zeta' }),
      p1: summary({ id: 'p1', name: 'Alpha' }),
      p3: summary({ id: 'p3', name: 'Mu' }),
    };
    // p3 is already open locally (a linked recent), so it must NOT be listed again.
    const available = [project({ file_path: '/a', speleodb_project_id: 'p3' })];
    const items = deriveRemoteOnlyItems(summaries, available);
    expect(items.map((i) => (i.kind === 'remote' ? i.summary.name : ''))).toEqual(['Alpha', 'Zeta']);
    expect(items.every((i) => i.kind === 'remote')).toBe(true);
  });

  it('returns nothing when every remote is already a local recent', () => {
    const summaries = { p1: summary({ id: 'p1' }) };
    const available = [project({ file_path: '/a', speleodb_project_id: 'p1' })];
    expect(deriveRemoteOnlyItems(summaries, available)).toEqual([]);
  });

  it('returns nothing when there are no scanned summaries', () => {
    expect(deriveRemoteOnlyItems({}, [project({ file_path: '/a' })])).toEqual([]);
  });
});

describe('buildRecentListItems', () => {
  it('places available rows first, then remote, then missing rows in order', () => {
    const withRemote = buildRecentListItems(
      [project({ file_path: '/a', name: 'A' })],
      ['/gone'],
      deriveRemoteOnlyItems({ p1: summary({ id: 'p1', name: 'Remote' }) }, []),
    );
    expect(withRemote.map((i) => i.kind)).toEqual(['available', 'remote', 'missing']);
  });

  it('places available rows first, then missing rows in order', () => {
    const items = buildRecentListItems(
      [project({ file_path: '/a', name: 'Alpha' })],
      ['/gone']
    );
    expect(items.map((i) => i.kind)).toEqual(['available', 'missing']);
    expect(items[1]).toMatchObject({ kind: 'missing', filePath: '/gone', name: 'gone' });
  });
});

describe('filterRecentListItems', () => {
  const items: RecentListItem[] = [
    { kind: 'available', filePath: '/caves/alpha.stalx', project: project({ file_path: '/caves/alpha.stalx', name: 'Cave Alpha', location: 'Mexico' }) },
    { kind: 'available', filePath: '/caves/beta.stalx', project: project({ file_path: '/caves/beta.stalx', name: 'Beta', location: 'Florida' }) },
    { kind: 'missing', filePath: '/old/gamma.stalx', name: 'gamma.stalx' },
  ];

  it('returns everything for an empty/whitespace term', () => {
    expect(filterRecentListItems(items, '')).toHaveLength(3);
    expect(filterRecentListItems(items, '   ')).toHaveLength(3);
  });

  // These fixture items are all available/missing (both carry filePath); the remote
  // kind (which has no filePath) is exercised in the deriveRemoteOnlyItems tests.
  const paths = (list: RecentListItem[]) => list.map((i) => ('filePath' in i ? i.filePath : ''));

  it('matches on name (case-insensitive)', () => {
    expect(paths(filterRecentListItems(items, 'alpha'))).toEqual(['/caves/alpha.stalx']);
  });

  it('matches available rows on location', () => {
    expect(paths(filterRecentListItems(items, 'florida'))).toEqual(['/caves/beta.stalx']);
  });

  it('matches on path, including missing rows', () => {
    expect(paths(filterRecentListItems(items, 'gamma'))).toEqual(['/old/gamma.stalx']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterRecentListItems(items, 'zzz')).toEqual([]);
  });
});
