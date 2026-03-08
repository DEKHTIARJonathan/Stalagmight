import { create } from 'zustand';

interface NetworkStore {
  isOnline: boolean;
  /** Bumped on each offline→online transition to trigger stale tile reload */
  tileReloadGeneration: number;
  setOnline: (online: boolean) => void;
  triggerTileReload: () => void;
}

export const useNetworkStore = create<NetworkStore>((set) => ({
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  tileReloadGeneration: 0,
  setOnline: (online) => set({ isOnline: online }),
  triggerTileReload: () => set((state) => ({ tileReloadGeneration: state.tileReloadGeneration + 1 })),
}));
