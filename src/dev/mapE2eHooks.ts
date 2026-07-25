/**
 * `window.__stalagmight_*` E2E hooks for the map, in one place.
 *
 * Why these exist: the survey is drawn by the CUSTOM WebGL renderer, so there are
 * no stock `survey-shots` / `survey-stations` MapLibre layers and no
 * `survey-data-*` vector-tile sources. A Playwright test therefore cannot use
 * `queryRenderedFeatures` / `querySourceFeatures` / `getFeatureState` /
 * `getPaintProperty` to find what is on screen. These hooks expose the same
 * authoritative state the renderer itself draws from (the SoA geometry index and
 * the custom layers' render data), so tests read what is actually painted.
 *
 * `e2e-playwright/helpers/app.ts` wraps each of these; specs use those helpers.
 * Installed by MapCanvas (see `installMapE2eHooks`) and removed on unmount, so
 * nothing leaks between projects.
 */

/** The slice of SurveyLayer these hooks read. Structural, to avoid importing the
 *  class (and its MapLibre graph) into this dev-only module. */
export interface MapE2eSurveyLayer {
  enumerateGeometry(): unknown;
  measuredPathDrawnCounts(): { shots: number; stations: number };
  dragGhostOffset(): unknown;
}

/** What `installMapE2eHooks` needs: live accessors, read at call time so the
 *  hooks always see the CURRENT layer/transform rather than a stale capture. */
export interface MapE2eHookSources {
  surveyLayer: () => MapE2eSurveyLayer | null | undefined;
  toMeters: (lng: number, lat: number) => { x: number; y: number };
}

interface HookWindow {
  __stalagmight_geometry__?: () => unknown;
  __stalagmight_measured__?: () => unknown;
  __stalagmight_drag_ghost__?: () => unknown;
  __stalagmight_to_meters__?: (lng: number, lat: number) => { x: number; y: number };
}

/**
 * Install the map E2E hooks; returns a disposer that removes them.
 *
 * - `__stalagmight_geometry__()` - every drawn station center + shot segment in
 *   MAP coords with identities, honoring the reference-shots toggle. Tests project
 *   these via `__stalagmight_map__.project(...)` for screen positions.
 * - `__stalagmight_measured__()` - measured-path (ruler) tint counts
 *   `{shots, stations}`; the tint is a custom GL layer with no feature-state.
 * - `__stalagmight_drag_ghost__()` - the live drag-preview offset `{mode, dx, dy}`,
 *   so a drag test never reaches into the ghost layer's private fields.
 * - `__stalagmight_to_meters__(lng, lat)` - the ACTIVE meters transform, so a test
 *   can predict a committed move offset with the same gpsOrigin the app uses (the
 *   no-GPS linear fallback and the ENU transform are not equivalent).
 */
export function installMapE2eHooks(sources: MapE2eHookSources): () => void {
  if (typeof window === 'undefined') return () => {};
  const w = window as unknown as HookWindow;

  w.__stalagmight_geometry__ = () => sources.surveyLayer()?.enumerateGeometry() ?? null;
  w.__stalagmight_measured__ = () =>
    sources.surveyLayer()?.measuredPathDrawnCounts() ?? { shots: 0, stations: 0 };
  w.__stalagmight_drag_ghost__ = () => sources.surveyLayer()?.dragGhostOffset() ?? null;
  w.__stalagmight_to_meters__ = (lng, lat) => sources.toMeters(lng, lat);

  return () => {
    delete w.__stalagmight_geometry__;
    delete w.__stalagmight_measured__;
    delete w.__stalagmight_drag_ghost__;
    delete w.__stalagmight_to_meters__;
  };
}
