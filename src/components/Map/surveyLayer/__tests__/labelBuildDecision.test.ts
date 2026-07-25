import { describe, it, expect } from 'vitest';
import {
  decideLabelBuild,
  skippedBuildForCamera,
  type LabelBuildInput,
} from '../labelBuildDecision';

// Mirrors SurveyLayer.LABEL_BUILD_ZOOM / LABEL_DROP_ZOOM.
const BUILD = 13.5;
const DROP = 13;

function input(partial: Partial<LabelBuildInput>): LabelBuildInput {
  return {
    currentlyBuilt: false,
    zoom: 14,
    cameraSettled: true,
    buildZoom: BUILD,
    dropZoom: DROP,
    ...partial,
  };
}

describe('decideLabelBuild', () => {
  it('builds fresh labels past the build threshold on a settled camera', () => {
    expect(decideLabelBuild(input({ currentlyBuilt: false, zoom: 14, cameraSettled: true }))).toBe(true);
  });

  it('does not build fresh labels below the build threshold', () => {
    expect(decideLabelBuild(input({ currentlyBuilt: false, zoom: 13.2, cameraSettled: true }))).toBe(false);
  });

  it('skips the FRESH build while the camera is mid-motion (memory guard)', () => {
    expect(decideLabelBuild(input({ currentlyBuilt: false, zoom: 16, cameraSettled: false }))).toBe(false);
  });

  // The regression: an in-place edit commit re-flushes while the camera briefly
  // reports moving. Already-built labels MUST be kept, or the sync commit flush
  // publishes empty label groups and the whole population blinks.
  it('KEEPS already-built labels while the camera is mid-motion', () => {
    expect(decideLabelBuild(input({ currentlyBuilt: true, zoom: 14.4, cameraSettled: false }))).toBe(true);
  });

  it('keeps already-built labels in the hysteresis band [dropZoom, buildZoom)', () => {
    expect(decideLabelBuild(input({ currentlyBuilt: true, zoom: 13.2, cameraSettled: true }))).toBe(true);
    expect(decideLabelBuild(input({ currentlyBuilt: true, zoom: 13.2, cameraSettled: false }))).toBe(true);
  });

  it('drops already-built labels once zoomed out below the drop threshold', () => {
    expect(decideLabelBuild(input({ currentlyBuilt: true, zoom: 12.5, cameraSettled: true }))).toBe(false);
    // Even mid-motion, a genuine zoom-out past dropZoom still drops.
    expect(decideLabelBuild(input({ currentlyBuilt: true, zoom: 12.5, cameraSettled: false }))).toBe(false);
  });

  it('builds fresh at exactly the build threshold, keeps built at exactly the drop threshold', () => {
    expect(decideLabelBuild(input({ currentlyBuilt: false, zoom: BUILD, cameraSettled: true }))).toBe(true);
    expect(decideLabelBuild(input({ currentlyBuilt: true, zoom: DROP, cameraSettled: true }))).toBe(true);
  });
});

describe('skippedBuildForCamera', () => {
  it('is true only when a fresh build was skipped for camera motion', () => {
    expect(skippedBuildForCamera(input({ currentlyBuilt: false, zoom: 16, cameraSettled: false }))).toBe(true);
  });

  it('is false when the camera is settled', () => {
    expect(skippedBuildForCamera(input({ currentlyBuilt: false, zoom: 16, cameraSettled: true }))).toBe(false);
  });

  it('is false when labels are already built (nothing to arm — they are kept)', () => {
    expect(skippedBuildForCamera(input({ currentlyBuilt: true, zoom: 16, cameraSettled: false }))).toBe(false);
  });

  it('is false when the zoom would not build labels anyway', () => {
    expect(skippedBuildForCamera(input({ currentlyBuilt: false, zoom: 13.2, cameraSettled: false }))).toBe(false);
  });
});
