import { describe, expect, it, vi } from 'vitest';

const invokeInApp = vi.hoisted(() => vi.fn());
vi.mock('./page', () => ({ invokeInApp, evalInApp: vi.fn() }));

import { driverScript } from './replayHelpers';
import type { Browser } from 'webdriverio';

describe('replayed driver scripts', () => {
  it('disables helpers after a timeout', async () => {
    const browser = {} as Browser;

    await expect(
      driverScript(
        browser,
        `await new Promise((resolve) => setTimeout(resolve, 20)); await ipc('late-mutation');`,
        5,
      ),
    ).rejects.toThrow('timed out after 5ms');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(invokeInApp).not.toHaveBeenCalled();
  });
});
