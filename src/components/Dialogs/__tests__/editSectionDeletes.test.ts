import { describe, it, expect } from 'vitest';
import { classifyDeleteRun, isEndRun } from '../editSectionDeletes';

const ORDER = ['a', 'b', 'c', 'd', 'e'];
const of = (...keys: string[]) => new Set(keys);

describe('classifyDeleteRun', () => {
  it('calls a single first or last shot an end run', () => {
    expect(classifyDeleteRun(ORDER, of('a'))).toBe('prefix');
    expect(classifyDeleteRun(ORDER, of('e'))).toBe('suffix');
  });

  it('calls a contiguous run at either end an end run', () => {
    expect(classifyDeleteRun(ORDER, of('a', 'b', 'c'))).toBe('prefix');
    expect(classifyDeleteRun(ORDER, of('c', 'd', 'e'))).toBe('suffix');
  });

  it('does not care what order the targets are given in', () => {
    expect(classifyDeleteRun(ORDER, of('e', 'c', 'd'))).toBe('suffix');
  });

  it('calls a run in the middle mid, however long', () => {
    expect(classifyDeleteRun(ORDER, of('c'))).toBe('mid');
    expect(classifyDeleteRun(ORDER, of('b', 'c', 'd'))).toBe('mid');
  });

  it('calls a gapped selection mid even when it touches an end', () => {
    // Deleting the first and the last leaves the middle stranded either way.
    expect(classifyDeleteRun(ORDER, of('a', 'c'))).toBe('mid');
    expect(classifyDeleteRun(ORDER, of('a', 'e'))).toBe('mid');
    expect(classifyDeleteRun(ORDER, of('a', 'b', 'd', 'e'))).toBe('mid');
  });

  it('calls the whole section all', () => {
    expect(classifyDeleteRun(ORDER, of(...ORDER))).toBe('all');
  });

  it('reports none when nothing in the selection is in the section', () => {
    expect(classifyDeleteRun(ORDER, of('zz'))).toBe('none');
    expect(classifyDeleteRun([], of('a'))).toBe('none');
  });

  it('treats a two-shot section as ends only - there is no middle', () => {
    expect(classifyDeleteRun(['a', 'b'], of('a'))).toBe('prefix');
    expect(classifyDeleteRun(['a', 'b'], of('b'))).toBe('suffix');
  });

  it('ignores targets that are not in the section', () => {
    expect(classifyDeleteRun(ORDER, of('d', 'e', 'ghost'))).toBe('suffix');
  });
});

describe('isEndRun', () => {
  it('lets everything but a mid delete through', () => {
    expect(isEndRun('prefix')).toBe(true);
    expect(isEndRun('suffix')).toBe(true);
    expect(isEndRun('all')).toBe(true);
    expect(isEndRun('none')).toBe(true);
    expect(isEndRun('mid')).toBe(false);
  });
});
