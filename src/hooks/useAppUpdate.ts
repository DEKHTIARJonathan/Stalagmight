import { useCallback, useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invokeIpc } from '../utils/ipc';
import { debugLog } from '../utils/debugLog';
import { useProjectStore } from '../store/projectStore';
import { useUpdateStore } from '../store/updateStore';
import type { AppUpdateCheck } from '../types/ipc/AppUpdateCheck';
import type { AppUpdateProgress } from '../types/ipc/AppUpdateProgress';
import type { UpdateTrack } from '../types/ipc/UpdateTrack';

/** How long after config loads before the automatic launch check fires (#579). */
const LAUNCH_CHECK_DELAY_MS = 10_000;

/**
 * Guards the automatic launch check to once per process - a module flag
 * (not a ref) because it must survive `useAppUpdate` being mounted more than
 * once conceptually across the app's lifetime (it is mounted once in App.tsx,
 * but a module flag is the one guarantee that holds regardless of how React
 * chooses to remount the tree).
 */
let launchCheckArmed = false;

/** Test-only reset so a leaked arm can't bleed across cases. */
export function resetAppUpdateLaunchCheckForTests(): void {
  launchCheckArmed = false;
}

/**
 * Drives the in-app updater's background checks (#579): mount once at app
 * root (see App.tsx). `check_for_app_update` deliberately does not gate on
 * `update_check_enabled` itself - this hook is the gate for the automatic
 * launch check; the About dialog's manual "Check for updates" button calls
 * the command directly and is unaffected by either the setting or this hook.
 */
export function useAppUpdate(): void {
  const config = useProjectStore((s) => s.config);
  const prevTrackRef = useRef<UpdateTrack | undefined>(undefined);

  const runCheck = useCallback(async () => {
    const store = useUpdateStore.getState();
    store.startChecking();
    try {
      const result = await invokeIpc<AppUpdateCheck>('check_for_app_update', undefined, {
        purpose: 'check for app update',
      });
      if (result.status.kind === 'available') {
        store.setAvailable({ version: result.status.version, notesUrl: result.status.notes_url });
      } else {
        store.setUpToDate();
      }
    } catch (e) {
      // A failed background check is never surfaced as a toast/banner
      // (docs/notifications.md) - log and quietly go idle.
      debugLog('[useAppUpdate] check failed:', e);
      store.setCheckFailed();
    }
  }, []);

  // (a) The automatic launch check: once per process, ~10s after config is
  // available, gated on update_check_enabled.
  useEffect(() => {
    if (!config || launchCheckArmed) return;
    launchCheckArmed = true;
    if (!config.general.update_check_enabled) return;
    const timer = window.setTimeout(() => {
      void runCheck();
    }, LAUNCH_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [config, runCheck]);

  // (b) Download progress, streamed while `download_app_update` is in flight.
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    (async () => {
      try {
        const fn = await listen<AppUpdateProgress>('app-update:download-progress', (event) => {
          useUpdateStore.getState().setProgress(event.payload);
        });
        if (disposed) fn();
        else unlisten = fn;
      } catch (e) {
        console.warn('[useAppUpdate] download-progress listener not available:', e);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // (c) A track switch (stable <-> weekly) re-checks against the new track,
  // which also clears a stale available-banner when the new track has
  // nothing on offer (runCheck -> setUpToDate resets info/progress). Not
  // gated on update_check_enabled: the user just made an explicit choice in
  // Settings, the same as pressing "Check for updates" in About.
  useEffect(() => {
    const track = config?.general.update_track;
    if (track === undefined) return;
    if (prevTrackRef.current === undefined) {
      prevTrackRef.current = track;
      return;
    }
    if (track !== prevTrackRef.current) {
      prevTrackRef.current = track;
      void runCheck();
    }
  }, [config?.general.update_track, runCheck]);
}
