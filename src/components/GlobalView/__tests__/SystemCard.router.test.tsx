/**
 * #450: recents cards must route opens through the shared open/import router
 * (`routeOpenedFile`) instead of calling `store.loadProject` directly, so the
 * same guards (SpeleoDB hand-back, unsaved-changes, swap confirm) that gate
 * every other `.stalx` entry point also gate a recents open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

const routeOpenedFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../../utils/openOrImport', () => ({
  routeOpenedFile: routeOpenedFileMock,
}));

import SystemCard from '../SystemCard';
import { systemCardTestId } from '../../../utils/testId';

const FILE_PATH = '/projects/cave-alpha.stalx';

beforeEach(() => {
  routeOpenedFileMock.mockClear();
});

describe('SystemCard - open router (#450)', () => {
  it('routes a double-click through routeOpenedFile with the card path', () => {
    const { getByTestId } = render(
      <SystemCard
        name="Alpha"
        location={null}
        filePath={FILE_PATH}
        modifiedAt="2026-07-26T00:00:00Z"
        sectionCount={3}
        totalLength={120}
      />,
    );

    fireEvent.doubleClick(getByTestId(systemCardTestId(FILE_PATH)));

    expect(routeOpenedFileMock).toHaveBeenCalledTimes(1);
    expect(routeOpenedFileMock).toHaveBeenCalledWith(FILE_PATH);
  });
});
