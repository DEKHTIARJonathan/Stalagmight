/**
 * Unit test (#241) - Plan/Export read-only toolbar layout has exactly one divider.
 *
 * `READ_ONLY_TOOLBAR_ITEMS` filters `TOOLBAR_ITEMS` down to the non-mutating tools
 * (Select / Pan / Zoom / Measure), which leaves two adjacent separators where the
 * merge/comment/move cluster used to sit. The old dangling-separator cleanup
 * dropped BOTH adjacent separators (each saw the other as a separator neighbor),
 * so Plan/Export rendered with no divider at all. The fix collapses runs of
 * consecutive separators to one and drops any leading/trailing separator.
 *
 * `READ_ONLY_TOOLBAR_ITEMS` and `TOOLBAR_ITEMS` are exported from `Toolbar.tsx`
 * for this test (they were module-private) - a pure array test is far cheaper
 * than a full component render, which would need uiStore/projectStore/speleoStore
 * wiring unrelated to this layout logic.
 */
import { describe, it, expect } from 'vitest';
import { filterToolbarItems, READ_ONLY_TOOLBAR_ITEMS, TOOLBAR_ITEMS } from './Toolbar';
import { isMutatingTool } from '../../utils/toolUtils';
import { isNavigationTool } from '../../utils/toolGroups';

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

/**
 * #409 - the navigate group (Pan/Zoom) is hidden unless the user opts in, because
 * the map pans on a plain drag and zooms on the wheel under every tool. Hiding it
 * strands separators exactly like the read-only filter does, and in Plan/Export
 * BOTH filters run, so the same cleanup has to survive a second pass over an
 * already-filtered layout.
 */
describe('navigation-tools filtering (#409)', () => {
  const hideNavigation = (items: typeof TOOLBAR_ITEMS) =>
    filterToolbarItems(items, (tool) => !isNavigationTool(tool));

  it('survey with navigation off is [Select] | [Merge Comment Move] | [Measure]', () => {
    const items = hideNavigation(TOOLBAR_ITEMS);
    expect(items).toEqual([
      { kind: 'standalone', id: 'select', shortcut: 'S' },
      { kind: 'separator' },
      { kind: 'standalone', id: 'merge', shortcut: 'M' },
      { kind: 'group', groupId: 'comment' },
      { kind: 'group', groupId: 'move' },
      { kind: 'separator' },
      { kind: 'standalone', id: 'measure', shortcut: 'R' },
    ]);
    expect(items.filter((i) => i.kind === 'separator')).toHaveLength(2);
    expect(items.some((i) => i.kind === 'group' && i.groupId === 'navigate')).toBe(false);
  });

  it('read-only with navigation off is [Select] | [Measure] - one divider, none dangling', () => {
    const items = hideNavigation(READ_ONLY_TOOLBAR_ITEMS);
    expect(items).toEqual([
      { kind: 'standalone', id: 'select', shortcut: 'S' },
      { kind: 'separator' },
      { kind: 'standalone', id: 'measure', shortcut: 'R' },
    ]);
    expect(items.filter((i) => i.kind === 'separator')).toHaveLength(1);
    expect(items[0]?.kind).not.toBe('separator');
    expect(items[items.length - 1]?.kind).not.toBe('separator');
  });

  it('the two filters commute: read-only-then-nav-off equals nav-off-then-read-only', () => {
    const navOffThenReadOnly = filterToolbarItems(
      hideNavigation(TOOLBAR_ITEMS),
      (tool) => !isMutatingTool(tool)
    );
    expect(navOffThenReadOnly).toEqual(hideNavigation(READ_ONLY_TOOLBAR_ITEMS));
  });
});

describe('filterToolbarItems group semantics', () => {
  it('keeps a group when only SOME of its members pass', () => {
    // move_segment is dropped, move_shot/move_station survive -> the group button
    // stays, because it can still reach a kept subtool.
    const items = filterToolbarItems(TOOLBAR_ITEMS, (tool) => tool !== 'move_segment');
    expect(items.some((i) => i.kind === 'group' && i.groupId === 'move')).toBe(true);
  });

  it('drops a group only when NO member passes', () => {
    const kept = filterToolbarItems(
      TOOLBAR_ITEMS,
      (tool) => tool !== 'move_segment' && tool !== 'move_shot'
    );
    expect(kept.some((i) => i.kind === 'group' && i.groupId === 'move')).toBe(true);

    const dropped = filterToolbarItems(
      TOOLBAR_ITEMS,
      (tool) => tool !== 'move_segment' && tool !== 'move_shot' && tool !== 'move_station'
    );
    expect(dropped.some((i) => i.kind === 'group' && i.groupId === 'move')).toBe(false);
  });
});
