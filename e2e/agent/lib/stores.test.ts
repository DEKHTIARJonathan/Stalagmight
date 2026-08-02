import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'webdriverio';

import { postDigest } from './stores';

afterEach(() => vi.unstubAllGlobals());

describe('postDigest', () => {
  it('reads the project name from the project root', async () => {
    vi.stubGlobal('window', {
      __E2E_TEST__: {
        uiStore: {
          getState: () => ({ view: 'single', activeDialog: null, activeTool: 'select' }),
        },
        projectStore: {
          getState: () => ({ project: { name: 'Harness project', metadata: { name: 'wrong legacy path' } } }),
        },
      },
    });
    const browser = {
      execute: vi.fn((fn: () => unknown) => Promise.resolve(fn())),
    } as unknown as Browser;

    await expect(postDigest(browser)).resolves.toEqual({
      view: 'single',
      dialog: null,
      activeTool: 'select',
      projectName: 'Harness project',
      projectOpen: true,
    });
  });
});
