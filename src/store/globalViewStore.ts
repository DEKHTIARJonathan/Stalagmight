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
   * Generation counter for cancellation.
   * Incremented on clearGeometryCache to invalidate in-flight requests.
   */
  generation: number;

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
   * Load geometry for a system by file path.
   * Skips if already loading/loaded.
   */
  loadGeometry: (filePath: string) => Promise<void>;

  /**
   * Load geometry for multiple systems sequentially.
   * Stops if generation changes (cache cleared).
   */
  loadGeometryBatch: (filePaths: string[]) => Promise<void>;

  /**
   * Get the loading state for a system.
   */
  getLoadingState: (filePath: string) => GeometryLoadingState;

  /**
   * Clear all cached geometry and cancel pending loads.
   * Call when entering single-system view.
   */
  clearGeometryCache: () => void;
}

export const useGlobalViewStore = create<GlobalViewStore>((set, get) => ({
  generation: 0,
  geometryStates: new Map(),
  geometryData: new Map(),

  loadGeometry: async (filePath: string) => {
    const startGeneration = get().generation;
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

      // Check if generation changed while in flight (cache was cleared)
      if (get().generation !== startGeneration) {
        return; // Discard result, don't update state
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
      // Check if generation changed while in flight
      if (get().generation !== startGeneration) {
        return; // Discard error, don't update state
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
    const startGeneration = get().generation;
    const { getLoadingState } = get();

    // Filter out already loading/loaded systems
    const toLoad = filePaths.filter((fp) => {
      const state = getLoadingState(fp);
      return state === 'idle' || state === 'error';
    });

    // Load sequentially to prevent overwhelming backend
    for (const filePath of toLoad) {
      // Stop if generation changed (cache cleared)
      if (get().generation !== startGeneration) {
        return;
      }
      await get().loadGeometry(filePath);
    }
  },

  getLoadingState: (filePath: string) => {
    return get().geometryStates.get(filePath)?.state ?? 'idle';
  },

  clearGeometryCache: () => {
    set((state) => ({
      generation: state.generation + 1,
      geometryStates: new Map(),
      geometryData: new Map(),
    }));
  },
}));
