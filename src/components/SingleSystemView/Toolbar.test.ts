/**
 * Unit test (#241) — Plan/Export read-only toolbar layout has exactly one divider.
 *
 * `READ_ONLY_TOOLBAR_ITEMS` filters `TOOLBAR_ITEMS` down to the non-mutating tools
 * (Select / Pan / Zoom / Measure), which leaves two adjacent separators where the
 * merge/comment/move cluster used to sit. The old dangling-separator cleanup
 * dropped BOTH adjacent separators (each saw the other as a separator neighbor),
 * so Plan/Export rendered with no divider at all. The fix collapses runs of
 * consecutive separators to one and drops any leading/trailing separator.
 *
 * `READ_ONLY_TOOLBAR_ITEMS` and `TOOLBAR_ITEMS` are exported from `Toolbar.tsx`
 * for this test (they were module-private) — a pure array test is far cheaper
 * than a full component render, which would need uiStore/projectStore/speleoStore
 * wiring unrelated to this layout logic.
 */
import { describe, it, expect } from 'vitest';
import { READ_ONLY_TOOLBAR_ITEMS, TOOLBAR_ITEMS } from './Toolbar';

describe('READ_ONLY_TOOLBAR_ITEMS (#241)', () => {
  it('collapses the two adjacent separators left by removing the mutating cluster to exactly one', () => {
    const separatorCount = READ_ONLY_TOOLBAR_ITEMS.filter((i) => i.kind === 'separator').length;
    expect(separatorCount).toBe(1);
  });

  it('renders [Select Pan/Zoom] | [Measure] with the divider between the nav cluster and Measure', () => {
    expect(READ_ONLY_TOOLBAR_ITEMS).toEqual([
      { kind: 'standalone', id: 'select', shortcut: 'S' },
      { kind: 'group', groupId: 'navigate' },
      { kind: 'separator' },
      { kind: 'standalone', id: 'measure', shortcut: 'R' },
    ]);
  });

  it('has no leading or trailing separator', () => {
    expect(READ_ONLY_TOOLBAR_ITEMS[0]?.kind).not.toBe('separator');
    expect(READ_ONLY_TOOLBAR_ITEMS[READ_ONLY_TOOLBAR_ITEMS.length - 1]?.kind).not.toBe('separator');
  });

  it('the full survey TOOLBAR_ITEMS still has its two dividers (sanity: filter didn\'t touch it)', () => {
    const separatorCount = TOOLBAR_ITEMS.filter((i) => i.kind === 'separator').length;
    expect(separatorCount).toBe(2);
  });
});
