/**
 * What a WebGL context restore must put right that changed while the context was
 * lost (#576 NF-MAP-5 follow-ups). MapLibre restores by re-applying the style it
 * serialized at the loss - filters and GeoJSON source data included - so state a
 * setter could not write during the loss comes back STALE unless the restore
 * replay rewrites it.
 *
 * Drives a REAL SurveyLayer over the fake map (surveyLayerFakeMap.ts), with the
 * loss and restore fired the way MapLibre fires them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// maplibre-gl sets up its worker at module init, which node lacks; SurveyLayer
// only needs the type surface here.
vi.mock('maplibre-gl', () => ({ default: {} }));

import SurveyLayer from '../SurveyLayer';
import { AUX_IDS } from '../surveyLayer/auxiliaryLayers';
import type { SurveyGeometryIndex } from '../surveyLayer/geometryIndex';
import { makeFakeSurveyMap, type FakeSurveyMap } from './surveyLayerFakeMap';

let fake: FakeSurveyMap;
let layer: SurveyLayer;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fake = makeFakeSurveyMap();
  layer = new SurveyLayer(fake.map);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The loss as MapLibre delivers it: the container snapshot, the style dropped, the map event. */
function loseContext(): void {
  fake.container.dispatchEvent(new Event('webglcontextlost'));
  fake.loseStyle();
  fake.fire('webglcontextlost');
}

/** The restore: the serialized style comes back and loads on the next frame. */
function restoreContext(): void {
  fake.restoreStyle();
  fake.fire('webglcontextrestored');
  fake.fire('style.load');
}

describe('a segment carry cancelled while the context is lost (#576 RV4-FE-SL1)', () => {
  /** Enough survey state for a segment pick-up of section 7 (no geometry to capture). */
  function armSegmentCarry(): void {
    Object.assign(layer as unknown as Record<string, unknown>, {
      geoIndex: {
        sectionGeometry: () => ({ stations: [], shots: [] }),
        stationCoords: () => null,
      } as unknown as SurveyGeometryIndex,
      cachedSurveyData: {},
      cachedSections: [{ id: 7, color: '#ffffff', shots: [] }],
    });
  }

  it("restores the loop closures' filter once the context is back", () => {
    armSegmentCarry();
    layer.beginDragPreview(new Set([7]));
    // The pick-up hides the closures touching the carried section.
    expect(fake.filter(AUX_IDS.loopClosuresLayerId)).toBeTruthy();

    loseContext();
    layer.endDragPreview(); // Escape / right-click during the loss
    restoreContext();

    console.log('[SL1] closure filter after cancel-during-loss + restore:', JSON.stringify(fake.filter(AUX_IDS.loopClosuresLayerId) ?? null));
    expect(fake.filter(AUX_IDS.loopClosuresLayerId)).toBeUndefined();

    // A later carry saves and restores the real (unfiltered) state, not a stale exclusion.
    layer.beginDragPreview(new Set([7]));
    layer.endDragPreview();
    expect(fake.filter(AUX_IDS.loopClosuresLayerId)).toBeUndefined();
  });

  it('a carry begun during the loss and ended after the restore still restores the original filter', () => {
    armSegmentCarry();
    layer.beginDragPreview(new Set([7]));
    loseContext();
    layer.endDragPreview();
    // Picked up again while the context is still lost: no style to save from.
    layer.beginDragPreview(new Set([7]));
    restoreContext();
    // Still carrying: the exclusion may stand until the drop...
    layer.endDragPreview();
    // ...which brings the closures back.
    expect(fake.filter(AUX_IDS.loopClosuresLayerId)).toBeUndefined();
  });
});
