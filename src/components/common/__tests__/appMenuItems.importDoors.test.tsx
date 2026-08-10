/**
 * The two hamburger doors, pinned by the picker each one opens (#508).
 *
 * "Open / Import" and "Import" are one word apart and route through the same
 * `routeOpenedFile`, so nothing downstream distinguishes them - the ONLY thing
 * that does is the filter set each hands to the picker. That makes these two
 * assertions the whole of the behavior: Open offers everything the app can open
 * or import, Import offers `.dmp` and nothing else (the one format that is
 * additive to an open project; every other one can only close it and start a
 * new project, which is Open's job).
 *
 * Pinned here rather than in an e2e because the mock picker returns a fixed
 * path regardless of the filters it is handed - an e2e click would pass just as
 * happily with the filters regrown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const pickAndRouteMock = vi.fn();
vi.mock('../../../utils/openOrImport', () => ({
  pickAndRoute: (...args: unknown[]) => pickAndRouteMock(...args),
}));

import { importMenuItem, leadingMenuItems } from '../appMenuItems';
import { openOrImportFilters, dmpImportFilters } from '../../../utils/fileDialogs';

const t = ((key: string) => key) as unknown as Parameters<typeof importMenuItem>[0];

beforeEach(() => {
  pickAndRouteMock.mockClear();
});

describe('hamburger import doors (#508)', () => {
  it('the in-project Import row picks .dmp only', () => {
    const item = importMenuItem(t);
    expect(item.submenu).toBeUndefined();
    (item.onClick as () => void)();
    expect(pickAndRouteMock).toHaveBeenCalledWith(dmpImportFilters(), 'Import Failed');
    // Pin the extension set itself, not just "equals the helper" - a helper
    // that quietly regrew .tml/.stalx entries would still satisfy the line
    // above while re-offering formats Import cannot apply to an open project.
    const [filters] = pickAndRouteMock.mock.calls[0]!;
    expect((filters as Array<{ extensions: string[] }>).flatMap((f) => f.extensions)).toEqual(['dmp']);
  });

  it('the Open / Import row keeps the full unified picker', () => {
    const open = leadingMenuItems(t, { onNewProject: () => {} }, 'hamburger').find(
      (i) => i.id === 'global-open-project-button',
    );
    (open?.onClick as () => void)();
    expect(pickAndRouteMock).toHaveBeenCalledWith(openOrImportFilters(), 'Open Failed');
  });
});
