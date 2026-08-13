import { create } from 'zustand';
import type { AppUpdateProgress } from '../types/ipc/AppUpdateProgress';

/**
 * In-app updater state (#579).
 *
 * `idle` covers both "never checked" and "checked, nothing new" - the banner
 * (and every other consumer) only ever needs to know there is nothing to show,
 * not why. A background check failure (docs/notifications.md: never a
 * toast/banner for a failed background check) also lands on `idle` via
 * {@link UpdateStore.setCheckFailed}; `error` is reserved for a download that
 * failed with no prior `info` to fall back to (should not happen in practice,
 * since a download is only ever started after `setAvailable`).
 */
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

export interface UpdateInfo {
  version: string;
  notesUrl: string;
}

interface UpdateStore {
  status: UpdateStatus;
  info: UpdateInfo | null;
  progress: AppUpdateProgress | null;
  /**
   * The version the user dismissed the banner for, this session only - NOT
   * persisted, so a dismissed update is offered again on the next launch.
   */
  dismissedVersion: string | null;

  startChecking: () => void;
  /** No update on offer - back to idle, clearing anything from a previous check. */
  setUpToDate: () => void;
  /** A background check failed - idle, silently (no toast/banner). */
  setCheckFailed: () => void;
  setAvailable: (info: UpdateInfo) => void;
  startDownloading: () => void;
  setProgress: (progress: AppUpdateProgress) => void;
  setReady: () => void;
  /** A download failed - the banner re-offers the download it already knows about. */
  setDownloadFailed: () => void;
  dismiss: (version: string) => void;
  /** Test-only reset. */
  reset: () => void;
}

const INITIAL_STATE: Pick<UpdateStore, 'status' | 'info' | 'progress' | 'dismissedVersion'> = {
  status: 'idle',
  info: null,
  progress: null,
  dismissedVersion: null,
};

export const useUpdateStore = create<UpdateStore>((set) => ({
  ...INITIAL_STATE,

  startChecking: () => set({ status: 'checking' }),
  setUpToDate: () => set({ status: 'idle', info: null, progress: null }),
  setCheckFailed: () => set({ status: 'idle', progress: null }),
  setAvailable: (info) => set({ status: 'available', info, progress: null }),
  startDownloading: () => set({ status: 'downloading' }),
  setProgress: (progress) => set({ progress }),
  setReady: () => set({ status: 'ready' }),
  setDownloadFailed: () =>
    set((state) => ({ status: state.info ? 'available' : 'error', progress: null })),
  dismiss: (version) => set({ dismissedVersion: version }),
  reset: () => set(INITIAL_STATE),
}));
