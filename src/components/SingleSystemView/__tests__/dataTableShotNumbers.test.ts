import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { Shot } from '../../../types/project';
import { buildShotColumns } from '../dataTableShotColumns';

const columns = buildShotColumns({
  t: ((key: string) => key) as TFunction,
  precision: { length: 2, azimuth: 1, depth: 1, inclination: 1 },
  sectionId: 1,
  geometryReadOnly: false,
  isShotFrozen: () => false,
  getShotWarnings: () => [],
  shotIndexAt: index => index,
  onCycleShotKind: vi.fn(),
});
const shotId = columns.find(column => column.key === 'shot_id')!;

describe('visible shot numbering', () => {
  it('shows the project-wide number instead of the section-encoded internal ID', () => {
    expect(shotId.getValue({ id: 100000, number: 1 } as Shot, 0)).toBe(1);
  });
  it('keeps the number when the internal ID and row position change', () => {
    expect(shotId.getValue({ id: 900003, number: 7 } as Shot, 12)).toBe(7);
  });
  it('leaves uncommitted draft IDs blank', () => {
    expect(shotId.getValue({ id: -1 } as Shot, 0)).toBe('');
  });
});
