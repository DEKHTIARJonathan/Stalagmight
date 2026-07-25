/**
 * Pure decision for whether station / shot label features should be
 * materialized for a survey flush (#customRender / #mem). Extracted from
 * SurveyLayer so it can be unit-tested without a live MapLibre map.
 *
 * Hysteresis: build once zoomed past `buildZoom`, drop only once zoomed out
 * below `dropZoom` — this band prevents thrashing at the threshold.
 *
 * Camera-settle guard: the guard exists ONLY to avoid MATERIALIZING the whole
 * (~165k-feature) label set against a *transient* zoom during a camera
 * animation (the unbuilt -> built transition on project load / a zoom-in ease).
 * It must NOT tear labels back down once they are already materialized: an
 * in-place edit commit (station / shot / segment move) re-flushes the survey
 * features through the SYNCHRONOUS drag-commit path, which publishes EMPTY label
 * groups when the build decision is false — blanking the entire shot + station
 * label population for the frames until the idle recheck rebuilds it (the
 * "all labels flash" bug). So the guard is applied to the fresh-build case only;
 * already-built labels are kept through transient camera motion.
 */
export interface LabelBuildInput {
  /** Whether label features are currently materialized in the sources. */
  currentlyBuilt: boolean;
  /** Current map zoom (0 when there is no live style). */
  zoom: number;
  /** Camera is settled: not animating AND no fit-to-bounds pending. */
  cameraSettled: boolean;
  /** Zoom at/above which labels start building (LABEL_BUILD_ZOOM). */
  buildZoom: number;
  /** Zoom below which already-built labels are dropped (LABEL_DROP_ZOOM). */
  dropZoom: number;
}

/** Zoom alone wants labels, under the build/drop hysteresis. */
function zoomWantsLabels(input: LabelBuildInput): boolean {
  return input.currentlyBuilt ? input.zoom >= input.dropZoom : input.zoom >= input.buildZoom;
}

/**
 * Decide whether to materialize label features for this flush.
 *
 * - Already built: keep whenever the zoom still wants them (>= dropZoom),
 *   regardless of transient camera motion. Never blanked by an edit commit.
 * - Not yet built: build only when the zoom wants them (>= buildZoom) AND the
 *   camera is settled, so a transient animation zoom never materializes the
 *   full label set the settled camera would not show.
 */
export function decideLabelBuild(input: LabelBuildInput): boolean {
  if (!zoomWantsLabels(input)) return false;
  return input.currentlyBuilt || input.cameraSettled;
}

/**
 * Whether `decideLabelBuild` skipped a fresh build purely because the camera
 * was mid-motion (unbuilt, zoom wants labels, but not settled). The caller
 * should arm a one-shot idle recheck to build once the camera settles.
 */
export function skippedBuildForCamera(input: LabelBuildInput): boolean {
  return !input.currentlyBuilt && !input.cameraSettled && input.zoom >= input.buildZoom;
}
