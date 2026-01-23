import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { SurveyGeometry } from '../types/survey';

/**
 * Loading state for a system's geometry.
 */
export type GeometryLoadingState = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * Per-system geometry state.
 */
export interface SystemGeometryState {
  /** Loading state of the geometry */
  state: GeometryLoadingState;
  /** The loaded geometry data (when state === 'loaded') */
  geometry?: SurveyGeometry;
  /** Error message (when state === 'error') */
  error?: string;
}

interface GlobalViewStore {
  /**
   * Geometry state keyed by file_path.
   * Systems not in the map are in 'idle' state.
   */
  geometryStates: Map<string, SystemGeometryState>;

  /**
   * Loaded geometry data for rendering.
   * Map of file_path -> SurveyGeometry.
   */
  geometryData: Map<string, SurveyGeometry>;

  /**
   * Set of file_paths with pending load cancellation.
   * Used to cancel loads when a project is opened.
   */
  pendingCancellations: Set<string>;

  /**
   * Load geometry for a system by file path.
   * Skips if already loading/loaded.
   */
  loadGeometry: (filePath: string) => Promise<void>;

  /**
   * Load geometry for multiple systems, prioritized by distance from viewport center.
   * Systems are loaded in order of priority.
   */
  loadGeometryBatch: (filePaths: string[]) => Promise<void>;

  /**
   * Cancel pending loads for a system.
   * Used when user opens a project to avoid race conditions.
   */
  cancelPendingLoads: (filePaths?: string[]) => void;

  /**
   * Get the loading state for a system.
   */
  getLoadingState: (filePath: string) => GeometryLoadingState;

  /**
   * Clear all cached geometry (call when entering single-system view).
   */
  clearGeometryCache: () => void;
}

export const useGlobalViewStore = create<GlobalViewStore>((set, get) => ({
  geometryStates: new Map(),
  geometryData: new Map(),
  pendingCancellations: new Set(),

  loadGeometry: async (filePath: string) => {
    const { geometryStates } = get();

    // Skip if already loading or loaded
    const currentState = geometryStates.get(filePath);
    if (currentState?.state === 'loading' || currentState?.state === 'loaded') {
      return;
    }

    // Mark as loading
    set((state) => ({
      geometryStates: new Map(state.geometryStates).set(filePath, {
        state: 'loading',
      }),
    }));

    try {
      const geometry = await invoke<SurveyGeometry>('get_survey_geometry_for_file', {
        path: filePath,
      });

      // Check if load was cancelled while in flight
      if (get().pendingCancellations.has(filePath)) {
        // Remove from pending cancellations
        set((state) => {
          const newCancellations = new Set(state.pendingCancellations);
          newCancellations.delete(filePath);
          return { pendingCancellations: newCancellations };
        });
        // Reset to idle
        set((state) => ({
          geometryStates: new Map(state.geometryStates).set(filePath, {
            state: 'idle',
          }),
        }));
        return;
      }

      // Success - update state and cache geometry
      set((state) => ({
        geometryStates: new Map(state.geometryStates).set(filePath, {
          state: 'loaded',
          geometry,
        }),
        geometryData: new Map(state.geometryData).set(filePath, geometry),
      }));
    } catch (e) {
      // Check if load was cancelled while in flight
      if (get().pendingCancellations.has(filePath)) {
        set((state) => {
          const newCancellations = new Set(state.pendingCancellations);
          newCancellations.delete(filePath);
          return { pendingCancellations: newCancellations };
        });
        set((state) => ({
          geometryStates: new Map(state.geometryStates).set(filePath, {
            state: 'idle',
          }),
        }));
        return;
      }

      // Error - parse error message
      let errorMessage = 'Failed to load geometry';
      if (typeof e === 'string') {
        try {
          const parsed = JSON.parse(e);
          errorMessage = parsed.message || e;
        } catch {
          errorMessage = e;
        }
      } else if (e && typeof e === 'object' && 'message' in e) {
        errorMessage = String((e as { message: unknown }).message);
      }

      set((state) => ({
        geometryStates: new Map(state.geometryStates).set(filePath, {
          state: 'error',
          error: errorMessage,
        }),
      }));
    }
  },

  loadGeometryBatch: async (filePaths: string[]) => {
    const { loadGeometry, getLoadingState } = get();

    // Filter out already loading/loaded systems
    const toLoad = filePaths.filter((fp) => {
      const state = getLoadingState(fp);
      return state === 'idle' || state === 'error';
    });

    // Load in sequence (could be parallelized, but sequential prevents overwhelming backend)
    for (const filePath of toLoad) {
      await loadGeometry(filePath);
    }
  },

  cancelPendingLoads: (filePaths?: string[]) => {
    set((state) => {
      const newCancellations = new Set(state.pendingCancellations);

      if (filePaths) {
        // Cancel specific file paths
        for (const fp of filePaths) {
          if (state.geometryStates.get(fp)?.state === 'loading') {
            newCancellations.add(fp);
          }
        }
      } else {
        // Cancel all loading
        for (const [fp, gs] of state.geometryStates) {
          if (gs.state === 'loading') {
            newCancellations.add(fp);
          }
        }
      }

      return { pendingCancellations: newCancellations };
    });
  },

  getLoadingState: (filePath: string) => {
    return get().geometryStates.get(filePath)?.state ?? 'idle';
  },

  clearGeometryCache: () => {
    set({
      geometryStates: new Map(),
      geometryData: new Map(),
      pendingCancellations: new Set(),
    });
  },
}));
