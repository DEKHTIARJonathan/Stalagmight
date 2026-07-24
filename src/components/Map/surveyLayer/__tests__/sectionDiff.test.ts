/**
 * Section-set diff tests. Moved here with `diffRemovedSectionIds` when it was
 * extracted from the deleted stock `labelRestore.ts`.
 */
import { describe, it, expect } from 'vitest';
import { diffRemovedSectionIds } from '../sectionDiff';

describe('diffRemovedSectionIds', () => {
  it('returns section ids in prev but not in next, in prev order', () => {
    const prev = [{ id: 1 }, { id: 5 }, { id: 8 }, { id: 12 }];
    const next = [{ id: 1 }, { id: 8 }];
    expect(diffRemovedSectionIds(prev, next)).toEqual([5, 12]);
  });

  it('returns [] when nothing was removed (edit / add only)', () => {
    const prev = [{ id: 1 }, { id: 2 }];
    const next = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(diffRemovedSectionIds(prev, next)).toEqual([]);
  });

  it('returns every id when the project emptied', () => {
    expect(diffRemovedSectionIds([{ id: 4 }, { id: 9 }], [])).toEqual([4, 9]);
  });

  it('short-circuits an empty prev (app start / project open)', () => {
    expect(diffRemovedSectionIds([], [{ id: 1 }])).toEqual([]);
  });
});
