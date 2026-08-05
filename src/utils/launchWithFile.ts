/**
 * Launch-with-file: OS "open with" -> the unified open/import router (#424).
 *
 * Double-clicking a `.stalx` (or any importable survey file) in Finder /
 * Explorer / a Linux file manager hands the path to the backend, which queues
 * it and emits `LAUNCH_FILE_EVENT` as a payload-free nudge. The queue - not the
 * event - carries the paths, for two reasons:
 *
 * - A COLD launch knows the file before the webview exists, so there is no
 *   listener to receive an event; the path waits in the queue instead.
 * - Draining is atomic, so a path cannot be handled twice by a listener that
 *   also polls, nor lost by a listener that mounts a beat late.
 *
 * Readiness: paths are only drained once the app is ready (config loaded, the
 * same signal the splash screen unmounts on). Routing earlier would hand the
 * router a project store that has not read its config yet. Anything that
 * arrives before then simply stays queued in the backend until `ready` flips.
 *
 * Everything routes through `routeOpenedFile`, so an OS-opened file gets
 * exactly the same guards as one picked from the toolbar: the unsaved-changes
 * and SpeleoDB hand-back prompts, the read-only import block, the
 * unsupported-extension error. No special-casing here.
 */
import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invokeIpc } from './ipc';
import { routeOpenedFile } from './openOrImport';
import { setProjectActionSource } from './telemetry';

/** Payload-free nudge from the backend; mirrors `LAUNCH_FILE_EVENT` in Rust. */
export const LAUNCH_FILE_EVENT = 'launch-file-queued';

/**
 * Drain the backend's pending-launch queue and route every path.
 *
 * Sequential on purpose: each route can open a dialog that owns the single
 * dialog slot, so two concurrent routes would have the second silently replace
 * the first. Two files opened at once is already an odd request; handling them
 * in order is the only reading that isn't lossy.
 */
export async function drainLaunchFiles(): Promise<void> {
  const paths = await invokeIpc<string[]>(
    'take_pending_launch_files',
    undefined,
    { purpose: 'collect files the OS asked us to open' },
  );
  for (const path of paths) {
    setProjectActionSource('os-file-association');
    await routeOpenedFile(path, 'Open Failed');
  }
}

/**
 * Route files the OS handed us, once the app is ready.
 *
 * @param ready App-readiness signal (config loaded). While false, incoming
 *   nudges are ignored and the paths stay queued in the backend; the drain runs
 *   on the transition to true.
 */
export function useLaunchWithFile(ready: boolean): void {
  // The listener is registered once and lives for the app's lifetime, so it
  // reads readiness through a ref rather than closing over a stale `ready`.
  const readyRef = useRef(ready);
  readyRef.current = ready;

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    void (async () => {
      const listener = await listen(LAUNCH_FILE_EVENT, () => {
        if (readyRef.current) void drainLaunchFiles();
      });
      if (disposed) listener();
      else unlisten = listener;
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    // Covers both the cold launch (queued before the webview existed) and any
    // nudge that landed while the app was still starting up.
    if (ready) void drainLaunchFiles();
  }, [ready]);
}
