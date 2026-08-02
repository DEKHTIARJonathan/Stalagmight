import { describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const invokeInApp = vi.hoisted(() => vi.fn());
vi.mock('./page', () => ({ invokeInApp, evalInApp: vi.fn() }));

import { cleanupReplayFixtures, driverScript, materializeReplayFixture } from './replayHelpers';
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

  it('waits for an in-flight helper to settle after the script times out', async () => {
    let release: (() => void) | undefined;
    invokeInApp.mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const browser = {} as Browser;
    const running = driverScript(browser, `await ipc('slow-mutation');`, 5);

    await new Promise((resolve) => setTimeout(resolve, 10));
    let rejected = false;
    void running.catch(() => { rejected = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(rejected).toBe(false);

    release?.();
    await expect(running).rejects.toThrow('settled during the grace window');
  });

  it('fences captured browser methods and closes the replay session on timeout', async () => {
    const mutate = vi.fn();
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const browser = { mutate, deleteSession } as unknown as Browser;

    await expect(
      driverScript(
        browser,
        `const lateMutation = browser.mutate; await new Promise((resolve) => setTimeout(resolve, 20)); await lateMutation();`,
        5,
      ),
    ).rejects.toThrow('settled during the grace window');

    expect(deleteSession).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('bounds quarantine when WebDriver session deletion never settles', async () => {
    const deleteSession = vi.fn(() => new Promise<never>(() => undefined));
    const browser = { deleteSession } as unknown as Browser;
    const started = Date.now();

    await expect(
      driverScript(browser, `await new Promise((resolve) => setTimeout(resolve, 20));`, 5),
    ).rejects.toThrow('settled during the grace window');

    expect(Date.now() - started).toBeLessThan(1500);
    expect(deleteSession).toHaveBeenCalledOnce();
  });
});

describe('replayed fixtures', () => {
  it('removes every copied database and SQLite sidecar after replay', () => {
    const first = materializeReplayFixture('fractal_plant_iter3.stalx');
    const second = materializeReplayFixture('fractal_plant_iter3.stalx');
    writeFileSync(`${first}-wal`, 'wal');
    writeFileSync(`${second}-shm`, 'shm');

    cleanupReplayFixtures();

    expect(existsSync(dirname(first))).toBe(false);
    expect(existsSync(dirname(second))).toBe(false);
  });
});
