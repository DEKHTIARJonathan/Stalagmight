/**
 * Tier 2 capture: real pixels of the app's own window.
 *
 * `screencapture -l <windowId>` reads the window out of the window server, so
 * it is occlusion-immune (a dialog parked on top of the app does not appear in
 * it) and it captures what the GPU actually drew - the map, which the Tier 1
 * DOM-serializing screenshot renders blank.
 *
 * There is deliberately NO full-screen fallback. With Screen Recording denied
 * `screencapture` still exits 0 and writes a desktop-wallpaper image, and a
 * fallback would turn "I could not find the window" into a picture that
 * downstream analysis would score as real evidence. Preflight first, capture
 * the window by id, and fail loudly if the file is not there.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { AgentSession } from '../sessionTypes';
import {
  defaultOsDeps,
  ensureAppFrontmost,
  requireAppPid,
  requireOsAccess,
  windowForPid,
  type OsActionEvidence,
  type OsDeps,
} from './input';

/** Wall-clock budget for one `screencapture` run. */
const CAPTURE_TIMEOUT_MS = 15_000;

export interface ScreenshotDeps extends OsDeps {
  capture: (windowId: number, outPath: string) => Promise<void>;
}

/**
 * `-x` mutes the shutter sound; `-o` drops the window shadow, so the image is
 * exactly the window bounds and dividing a pixel coordinate by the backing
 * scale lands back on the point that produced it.
 */
function screencaptureWindow(windowId: number, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'screencapture',
      ['-x', '-o', '-l', String(windowId), outPath],
      { timeout: CAPTURE_TIMEOUT_MS },
      (error, _out, errOut) => {
        if (error) {
          reject(new Error(`screencapture -l ${windowId} failed: ${errOut.trim() || error.message}`));
        } else {
          resolve();
        }
      },
    );
  });
}

export const defaultScreenshotDeps: ScreenshotDeps = {
  ...defaultOsDeps,
  capture: screencaptureWindow,
};

/** Bytes on disk, or null when nothing was written. */
function writtenSize(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

/**
 * Capture the app window to `outPath`. Requires Screen Recording on top of the
 * Accessibility every os_* action needs, because without it the capture is a
 * wrong picture rather than an error.
 */
export async function osScreenshot(
  session: AgentSession,
  outPath: string,
  deps: ScreenshotDeps = defaultScreenshotDeps,
): Promise<{ path: string; windowId: number } & OsActionEvidence> {
  const permissions = await requireOsAccess(deps, true);
  const appPid = requireAppPid(session);
  const frontmostOk = await ensureAppFrontmost(appPid, deps);
  const window = await windowForPid(appPid, deps);

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  await deps.capture(window.windowId, outPath);

  const size = writtenSize(outPath);
  if (size === null) {
    throw new Error(`screencapture reported success but wrote no file at ${outPath}`);
  }
  if (size === 0) {
    throw new Error(`screencapture wrote an empty file at ${outPath}; the capture did not happen`);
  }

  return { path: outPath, windowId: window.windowId, frontmost_ok: frontmostOk, permissions };
}
