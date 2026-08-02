import { describe, expect, it, vi } from 'vitest';
import type { Browser } from 'webdriverio';

import { evalInApp } from './page';

function executingBrowser(): Browser {
  return {
    executeAsync: vi.fn(
      (runner: (args: unknown[], done: (result: unknown) => void) => void, args: unknown[]) =>
        new Promise((resolve) => runner(args, resolve)),
    ),
  } as unknown as Browser;
}

describe('evalInApp', () => {
  it('compiles in the driver and executes the fixed function through WebDriver', async () => {
    const browser = executingBrowser();
    await expect(evalInApp<number>(browser, 'return args[0] * args[1];', [6, 7])).resolves.toBe(42);

    const runner = vi.mocked(browser.executeAsync).mock.calls[0]?.[0];
    expect(String(runner)).not.toContain('new Function');
  });

  it('returns page-script failures as agent errors', async () => {
    await expect(evalInApp(executingBrowser(), 'throw new Error("broken");')).rejects.toThrow('eval: Error: broken');
  });
});
