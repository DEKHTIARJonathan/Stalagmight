/**
 * Launch-with-file: OS "open with" -> the unified open/import router (#424).
 *
 * Double-clicking a `.stalx` or an Ariane `.tml`/`.tmlu` in Finder / Explorer /
 * a Linux file manager hands the path to the backend, which queues it and emits
 * `LAUNCH_FILE_EVENT` as a payload-free nudge. The queue - not the event -
 * carries the paths, for two reasons:
 *
 * - A COLD launch knows the file before the webview exists, so there is no
 *   listener to receive an event; the path waits in the queue instead.
 * - Draining is atomic, so a path cannot be handled twice by a listener that
 *   also polls, nor lost by a listener that mounts a beat late.
 *
 * Three things make this safe to hand to `routeOpenedFile`, and each is a
 * separate mechanism because each fails differently:
 *
 * 1. READINESS. Paths are only drained once the app is ready (config loaded -
 *    the same signal the splash screen unmounts on). Routing earlier would run
 *    the router against a project store that has not read its config yet.
 * 2. SERIALIZATION. Drains are chained through one promise, and within a drain
 *    exactly one path is routed per COMPLETED flow. `routeOpenedFile` resolves
 *    when it hands off to a dialog, NOT when the flow finishes, so awaiting it
 *    in a loop is not enough: path 2 would `openDialog` into the single dialog
 *    slot and replace path 1's prompt, losing path 1 with no trace. The
 *    remainder is held here and re-drained when the slot clears.
 * 3. CONSENT. A forwarded launch is remote control - anything that can run a
 *    program as this user can hand the running app a file. The one case where
 *    the router would displace open work with no prompt of its own - a
 *    `.stalx` over a clean project - is gated by `routeOpenedFile` itself, so
 *    this module doesn't need its own check: it just tags the source and
 *    delegates.
 */
import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useUIStore } from '../store/uiStore';
import { invokeIpc } from './ipc';
import { routeOpenedFile } from './openOrImport';
import { setProjectActionSource } from './telemetry';

/** Payload-free nudge from the backend; mirrors `LAUNCH_FILE_EVENT` in Rust. */
export const LAUNCH_FILE_EVENT = 'launch-file-queued';

/** Error title for every open the OS asked for. */
const LAUNCH_ERROR_TITLE = 'Open Failed';

/**
 * Paths taken from the backend queue but not yet routed, because the screen was
 * busy with the previous one's flow. Module-level, not per-hook: the hook can
 * remount (Fast Refresh, a Strict Mode double-invoke) and these must not be
 * dropped - they are open requests the user made.
 */
let deferred: string[] = [];

/** Tail of the drain chain, so two nudges can never interleave two drains. */
let chain: Promise<void> = Promise.resolve();

/** Test seam: drop the state that outlives a hook instance. */
export function resetLaunchFileQueueForTest(): void {
  deferred = [];
  chain = Promise.resolve();
}

/**
 * Is the single dialog slot (or a placement flow) occupied?
 *
 * The same pair `uiStore` itself treats as "the screen is not idle". Routing a
 * second path now would replace whatever is on screen.
 */
function screenBusy(): boolean {
  const ui = useUIStore.getState();
  return ui.activeDialog !== null || ui.placementMode !== null;
}

/**
 * Route one OS-sourced path. `routeOpenedFile` raises its own confirm when
 * this would swap out a clean, already-open project (the one case a launch
 * channel arrival can't just barrel through) - that guard now covers every
 * `.stalx`-open entry point, not just this one, so there's nothing to check
 * here beyond tagging the source.
 */
async function routeLaunchedFile(path: string): Promise<void> {
  setProjectActionSource('os-file-association');
  await routeOpenedFile(path, LAUNCH_ERROR_TITLE);
}

/**
 * One pass: take whatever the backend has, then route as many as the screen
 * allows - one per completed flow, holding the rest for the next pass.
 */
async function runDrain(): Promise<void> {
  const fetched = await invokeIpc<string[]>('take_pending_launch_files', undefined, {
    purpose: 'collect files the OS asked us to open',
  });
  deferred = deferred.concat(fetched);
  while (deferred.length > 0) {
    // Checked BEFORE each route, so it covers both "a dialog was already open
    // when the file arrived" and "the previous path just opened one".
    if (screenBusy()) return;
    const path = deferred[0] as string;
    deferred = deferred.slice(1);
    await routeLaunchedFile(path);
  }
}

/**
 * Drain the backend's pending-launch queue and route what the screen allows.
 *
 * Serialized: concurrent callers (a nudge landing mid-drain, a readiness flip
 * racing a nudge) queue behind the drain in flight rather than interleaving two
 * loops through the single dialog slot.
 */
export function drainLaunchFiles(): Promise<void> {
  const next = chain.then(runDrain);
  // The chain must not carry a rejection forward (it would reject every later
  // drain), and must not surface one as unhandled either.
  chain = next.catch(() => {});
  return next;
}

/** Fire-and-forget drain: these callers have no one to report an error to. */
function drainInBackground(): void {
  void drainLaunchFiles().catch((err: unknown) => {
    console.error('[launch] draining OS-opened files failed', err);
  });
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
        if (readyRef.current) drainInBackground();
      });
      if (disposed) listener();
      else unlisten = listener;
    })();

    // Re-drain when the screen goes idle: a path held back because the previous
    // one owned the dialog slot is only routable once that flow ends, and
    // nothing else will ask again.
    let wasBusy = screenBusy();
    const unsubscribe = useUIStore.subscribe(() => {
      const busy = screenBusy();
      const cleared = wasBusy && !busy;
      wasBusy = busy;
      if (cleared && deferred.length > 0 && readyRef.current) drainInBackground();
    });

    return () => {
      disposed = true;
      unlisten?.();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    // Covers both the cold launch (queued before the webview existed) and any
    // nudge that landed while the app was still starting up.
    if (ready) drainInBackground();
  }, [ready]);
}
