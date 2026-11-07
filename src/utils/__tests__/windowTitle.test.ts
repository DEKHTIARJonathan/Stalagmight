// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const setTitle = vi.fn();
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle }),
}));

import { applyWindowTitle, resetWindowTitleWarningForTest } from '../windowTitle';

describe('applyWindowTitle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setTitle.mockReset();
    resetWindowTitleWarningForTest();
    document.title = '';
  });

  it('sets the native title and leaves document.title alone on success', async () => {
    setTitle.mockResolvedValue(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await applyWindowTitle('Stalagmight - a.stalx *');
    expect(setTitle).toHaveBeenCalledWith('Stalagmight - a.stalx *');
    expect(document.title).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to document.title and warns once on rejection', async () => {
    setTitle.mockRejectedValue(new Error('not allowed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await applyWindowTitle('one');
    await applyWindowTitle('two');
    expect(document.title).toBe('two');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
