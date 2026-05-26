import { describe, it, expect } from 'vitest';
import {
  ensureExtension,
  projectOpenFilters,
  projectSaveFilters,
  dmpOpenFilters,
  compassOpenFilters,
  importOpenFilters,
  exportSaveFilters,
  PROJECT_EXTENSION,
  DMP_EXTENSION,
  COMPASS_EXTENSIONS,
} from '../fileDialogs';

// ---------------------------------------------------------------------------
// ensureExtension
// ---------------------------------------------------------------------------

describe('ensureExtension', () => {
  it('appends extension when no extension present', () => {
    expect(ensureExtension('myfile', 'stalx')).toBe('myfile.stalx');
  });

  it('appends extension with leading dot normalized', () => {
    expect(ensureExtension('myfile', '.stalx')).toBe('myfile.stalx');
  });

  it('returns path unchanged when already has correct extension', () => {
    expect(ensureExtension('myfile.stalx', 'stalx')).toBe('myfile.stalx');
  });

  it('handles case-insensitive extension matching', () => {
    expect(ensureExtension('myfile.STALX', 'stalx')).toBe('myfile.STALX');
    expect(ensureExtension('myfile.Stalx', 'stalx')).toBe('myfile.Stalx');
  });

  it('replaces existing different extension', () => {
    expect(ensureExtension('myfile.txt', 'stalx')).toBe('myfile.stalx');
    expect(ensureExtension('myfile.csv', 'json')).toBe('myfile.json');
  });

  it('handles path with directory separators', () => {
    expect(ensureExtension('/home/user/myfile', 'stalx')).toBe('/home/user/myfile.stalx');
    expect(ensureExtension('/home/user/myfile.txt', 'stalx')).toBe('/home/user/myfile.stalx');
  });

  it('handles Windows-style path separators', () => {
    expect(ensureExtension('C:\\Users\\test\\file', 'stalx')).toBe('C:\\Users\\test\\file.stalx');
    expect(ensureExtension('C:\\Users\\test\\file.txt', 'stalx')).toBe('C:\\Users\\test\\file.stalx');
  });

  it('handles dot in directory name but no file extension', () => {
    // The dot in "v1.0" is in a directory, not an extension
    expect(ensureExtension('/home/v1.0/myfile', 'stalx')).toBe('/home/v1.0/myfile.stalx');
  });

  it('handles file with multiple dots', () => {
    expect(ensureExtension('my.cave.project.txt', 'stalx')).toBe('my.cave.project.stalx');
  });
});

// ---------------------------------------------------------------------------
// Filter functions
// ---------------------------------------------------------------------------

describe('filter functions', () => {
  it('projectOpenFilters includes project and all files', () => {
    const filters = projectOpenFilters();
    expect(filters).toHaveLength(2);
    expect(filters[0]!.extensions).toContain(PROJECT_EXTENSION);
    expect(filters[1]!.extensions).toContain('*');
  });

  it('projectSaveFilters includes only project extension', () => {
    const filters = projectSaveFilters();
    expect(filters).toHaveLength(1);
    expect(filters[0]!.extensions).toContain(PROJECT_EXTENSION);
  });

  it('dmpOpenFilters includes dmp and all files', () => {
    const filters = dmpOpenFilters();
    expect(filters).toHaveLength(2);
    expect(filters[0]!.extensions).toContain(DMP_EXTENSION);
    expect(filters[1]!.extensions).toContain('*');
  });

  it('compassOpenFilters includes mak/dat and all files', () => {
    const filters = compassOpenFilters();
    expect(filters).toHaveLength(2);
    expect(filters[0]!.extensions).toContain('mak');
    expect(filters[0]!.extensions).toContain('dat');
    expect(filters[1]!.extensions).toContain('*');
  });

  it('importOpenFilters includes compass extensions', () => {
    const filters = importOpenFilters();
    const allSurvey = filters[0]!.extensions;
    expect(allSurvey).toContain('mak');
    expect(allSurvey).toContain('dat');
    expect(filters.some((f) => f.name === 'Compass Survey')).toBe(true);
  });

  it('exportSaveFilters creates filter with label and normalized extension', () => {
    const filters = exportSaveFilters('PNG Image', '.png');
    expect(filters).toHaveLength(1);
    expect(filters[0]!.name).toBe('PNG Image');
    expect(filters[0]!.extensions).toContain('png');
  });

  it('exportSaveFilters handles extension without leading dot', () => {
    const filters = exportSaveFilters('CSV', 'csv');
    expect(filters[0]!.extensions).toContain('csv');
  });

  it('constants are correct', () => {
    expect(PROJECT_EXTENSION).toBe('stalx');
    expect(DMP_EXTENSION).toBe('dmp');
    expect(COMPASS_EXTENSIONS).toEqual(['mak', 'dat']);
  });
});
