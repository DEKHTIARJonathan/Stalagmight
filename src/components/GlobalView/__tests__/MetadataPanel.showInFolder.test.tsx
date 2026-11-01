/**
 * Component test (#576): "Show in folder" falls back to opening the project's
 * folder when revealing the file itself fails. The folder is everything before
 * the file name, on either separator - splitting on '/' alone handed the
 * opener an empty path for a Windows `C:\...` project.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/ipc')>()),
  invokeIpc: invokeIpcMock,
}));

import MetadataPanel from '../MetadataPanel';
import type { ProjectMetadata } from '../../../types/project';

const projectAt = (file_path: string): ProjectMetadata =>
  ({
    name: 'CaveA',
    location: null,
    file_path,
    modified_at: new Date(0).toISOString(),
    section_count: 1,
    total_length: 10,
    gps_center: null,
    gps_bounds: null,
  } as ProjectMetadata);

/** Click Show in folder with the reveal failing; return the folder the fallback opened. */
const fallbackFolderFor = async (filePath: string): Promise<unknown> => {
  render(<MetadataPanel project={projectAt(filePath)} onOpenProject={vi.fn()} onRemoveFromRecent={vi.fn()} />);
  await userEvent.click(screen.getByTestId('metadata-show-folder-button'));
  await waitFor(() => expect(invokeIpcMock).toHaveBeenCalledWith('plugin:opener|open_path', expect.anything(), expect.anything()));
  const call = invokeIpcMock.mock.calls.find(([cmd]) => cmd === 'plugin:opener|open_path');
  return (call?.[1] as { path?: unknown } | undefined)?.path;
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  invokeIpcMock.mockReset();
  invokeIpcMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'plugin:opener|reveal_item_in_dir') throw new Error('reveal unavailable');
    return undefined;
  });
});

describe('MetadataPanel Show in folder fallback', () => {
  it('opens the containing folder of a Windows backslash path', async () => {
    expect(await fallbackFolderFor('C:\\caves\\CaveA.stalx')).toBe('C:\\caves');
  });

  it('opens the containing folder of a POSIX path', async () => {
    expect(await fallbackFolderFor('/home/user/caves/CaveA.stalx')).toBe('/home/user/caves');
  });
});
