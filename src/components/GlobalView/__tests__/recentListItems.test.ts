import { describe, it, expect } from 'vitest';
import {
  fileNameFromPath,
  deriveMissingPaths,
  buildRecentListItems,
  filterRecentListItems,
  type RecentListItem,
} from '../recentListItems';
import type { ProjectMetadata } from '../../../types/project';

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

describe('buildRecentListItems', () => {
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

  it('matches on name (case-insensitive)', () => {
    expect(filterRecentListItems(items, 'alpha').map((i) => i.filePath)).toEqual(['/caves/alpha.stalx']);
  });

  it('matches available rows on location', () => {
    expect(filterRecentListItems(items, 'florida').map((i) => i.filePath)).toEqual(['/caves/beta.stalx']);
  });

  it('matches on path, including missing rows', () => {
    expect(filterRecentListItems(items, 'gamma').map((i) => i.filePath)).toEqual(['/old/gamma.stalx']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterRecentListItems(items, 'zzz')).toEqual([]);
  });
});
