/**
 * Tier 2 capture, unit level. `screencapture` itself is injected - the suite
 * writes the "captured" bytes itself into a temp dir - so nothing here reads a
 * pixel of the real screen or needs Screen Recording. The fakes are deliberately
 * local rather than imported from input.test.ts: importing a test module would
 * re-register its suites here and run them twice.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'webdriverio';

import type { AgentSession } from '../sessionTypes';
import type { OsDeps } from './input';
import { osScreenshot, type ScreenshotDeps } from './screenshot';

// This process: requireAppPid rejects a pid that is not running.
const APP_PID = process.pid;
const WINDOW_ID = 77;
const FRAME = { x: 100, y: 50, w: 1000, h: 728 };

let tempDir: string;
let outPath: string;

interface FakeOptions {
  frontmost?: number[];
  accessibility?: boolean;
  screenRecording?: boolean;
  /** Bytes the fake capture writes; null writes no file at all. */
  captureBytes?: number | null;
}

function fakeScreenshotDeps(options: FakeOptions = {}): {
  deps: ScreenshotDeps;
  helperCalls: string[][];
  capture: ReturnType<typeof vi.fn>;
} {
  const helperCalls: string[][] = [];
  const frontmost = [...(options.frontmost ?? [APP_PID])];
  const bytes = options.captureBytes === undefined ? 128 : options.captureBytes;

  const capture = vi.fn(async (_windowId: number, file: string) => {
    if (bytes !== null) fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  });

  const runHelper = (async (args: string[]) => {
    helperCalls.push(args);
    switch (args[0]) {
      case 'frontmost': {
        const pid = frontmost.length > 1 ? frontmost.shift() : frontmost[0];
        return { ok: true, pid, app: 'Stalagmight', windowId: WINDOW_ID };
      }
      case 'window-id':
        return { ok: true, windowId: WINDOW_ID, pid: APP_PID, app: 'Stalagmight', bounds: FRAME };
      default:
        throw new Error(`unexpected helper call: ${args.join(' ')}`);
    }
  }) as unknown as OsDeps['runHelper'];

  return {
    helperCalls,
    capture,
    deps: {
      runHelper,
      requireGrant: () => {},
      preflight: (async () => ({
        ok: true,
        accessibility: options.accessibility ?? true,
        screenRecording: options.screenRecording ?? true,
      })) as unknown as OsDeps['preflight'],
      evalInApp: (async () => {
        throw new Error('a window capture must not need the webview');
      }) as unknown as OsDeps['evalInApp'],
      activate: vi.fn(async () => {}),
      sleep: async () => {},
      capture,
    },
  };
}

function fakeSession(appPid: number | null = APP_PID, state = 'ready'): AgentSession {
  return { browser: {} as Browser, state, appPid: () => appPid } as unknown as AgentSession;
}

beforeEach(() => {
  vi.clearAllMocks();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stal-os-shot-'));
  outPath = path.join(tempDir, 'nested', 'window.png');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('osScreenshot', () => {
  it('captures the app window by id and reports the evidence conditions', async () => {
    const { deps, capture, helperCalls } = fakeScreenshotDeps();

    await expect(osScreenshot(fakeSession(), outPath, deps)).resolves.toEqual({
      path: outPath,
      windowId: WINDOW_ID,
      frontmost_ok: true,
      permissions: { accessibility: true, screenRecording: true },
    });
    expect(capture).toHaveBeenCalledWith(WINDOW_ID, outPath);
    expect(helperCalls.at(-1)).toEqual(['window-id', '--pid', String(APP_PID)]);
    // The parent directory is created for the capture, not assumed.
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it('refuses to capture while Screen Recording is denied', async () => {
    const { deps, capture, helperCalls } = fakeScreenshotDeps({ screenRecording: false });

    await expect(osScreenshot(fakeSession(), outPath, deps)).rejects.toThrow(
      'macOS Screen Recording permission is not granted',
    );
    expect(capture).not.toHaveBeenCalled();
    expect(helperCalls).toEqual([]);
  });

  it('refuses to capture while Accessibility is denied', async () => {
    const { deps, capture } = fakeScreenshotDeps({ accessibility: false });

    await expect(osScreenshot(fakeSession(), outPath, deps)).rejects.toThrow(
      'macOS Accessibility permission is not granted',
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it('fails loudly on an empty file instead of returning a path to nothing', async () => {
    const { deps } = fakeScreenshotDeps({ captureBytes: 0 });

    await expect(osScreenshot(fakeSession(), outPath, deps)).rejects.toThrow(
      'screencapture wrote an empty file',
    );
  });

  it('fails loudly when nothing was written at all', async () => {
    const { deps } = fakeScreenshotDeps({ captureBytes: null });

    await expect(osScreenshot(fakeSession(), outPath, deps)).rejects.toThrow(
      'reported success but wrote no file',
    );
  });

  it('captures anyway when focus was lost, and labels the evidence as untrustworthy', async () => {
    const { deps, capture } = fakeScreenshotDeps({ frontmost: [999, 999] });

    await expect(osScreenshot(fakeSession(), outPath, deps)).resolves.toMatchObject({
      frontmost_ok: false,
    });
    expect(capture).toHaveBeenCalledOnce();
  });

  it('stops when no app pid is known', async () => {
    const { deps, capture } = fakeScreenshotDeps();

    await expect(osScreenshot(fakeSession(null), outPath, deps)).rejects.toThrow('no app pid is known');
    expect(capture).not.toHaveBeenCalled();
  });
});
