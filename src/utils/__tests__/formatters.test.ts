import { describe, it, expect } from 'vitest';
import { formatShotId, formatStationId } from '../formatters';

describe('formatShotId', () => {
  it('formats section and shot position', () => {
    expect(formatShotId(5, 3)).toBe('5:3');
  });

  it('formats first shot in first section', () => {
    expect(formatShotId(1, 1)).toBe('1:1');
  });

  it('formats larger numbers', () => {
    expect(formatShotId(123, 456)).toBe('123:456');
  });

  it('handles single digit values', () => {
    expect(formatShotId(1, 2)).toBe('1:2');
    expect(formatShotId(9, 9)).toBe('9:9');
  });

  it('formats zero values (edge case, though typically 1-indexed)', () => {
    expect(formatShotId(0, 0)).toBe('0:0');
  });
});

describe('formatStationId', () => {
  it('formats section and station index', () => {
    expect(formatStationId(5, 3)).toBe('5:3');
  });

  it('formats first station in first section (0-indexed)', () => {
    expect(formatStationId(1, 0)).toBe('1:0');
  });

  it('formats larger numbers', () => {
    expect(formatStationId(123, 456)).toBe('123:456');
  });

  it('handles single digit values', () => {
    expect(formatStationId(1, 2)).toBe('1:2');
    expect(formatStationId(9, 9)).toBe('9:9');
  });

  it('handles zero values', () => {
    expect(formatStationId(0, 0)).toBe('0:0');
  });
});
