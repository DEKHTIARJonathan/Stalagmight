import { describe, expect, it } from 'vitest';
import { LABEL_FLAG, LABEL_VERTEX_SRC } from '../labelShaders';

/**
 * Label flag contract (#customRender labels, Phase 5). Locks the HIDE-bit SPLIT:
 * COLLIDE_HIDE (declutter) and DRAG_HIDE (a move drag) are distinct bits so a
 * flags-only re-upload can flip one without disturbing the other, and the vertex
 * shader collapses on EITHER.
 */
describe('LABEL_FLAG bit contract', () => {
  it('every flag is a distinct single bit', () => {
    const values = Object.values(LABEL_FLAG);
    // Each is a power of two.
    for (const v of values) expect(v & (v - 1)).toBe(0);
    // No two share a bit.
    let acc = 0;
    for (const v of values) {
      expect(acc & v).toBe(0);
      acc |= v;
    }
    expect(Object.keys(LABEL_FLAG)).toHaveLength(6);
  });

  it('splits collision-hide from drag-hide (independent bits)', () => {
    expect(LABEL_FLAG.COLLIDE_HIDE).not.toBe(LABEL_FLAG.DRAG_HIDE);
    expect(LABEL_FLAG.COLLIDE_HIDE & LABEL_FLAG.DRAG_HIDE).toBe(0);
  });

  it('the vertex shader collapses on either hide bit', () => {
    expect(LABEL_VERTEX_SRC).toContain('FLAG_COLLIDE_HIDE | FLAG_DRAG_HIDE');
    expect(LABEL_VERTEX_SRC).not.toContain('FLAG_HIDE ');
  });
});
