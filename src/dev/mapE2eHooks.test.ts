// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installMapE2eHooks, type SemanticMapTarget } from './mapE2eHooks';

type HookWindow = Window & {
  __stalagmight_map_interaction__?: () => number;
  __stalagmight_set_map_target__?: (target: SemanticMapTarget) => boolean;
};

afterEach(() => {
  delete (window as HookWindow).__stalagmight_map_interaction__;
  delete (window as HookWindow).__stalagmight_set_map_target__;
});

describe('map E2E controls', () => {
  it('exposes semantic controls only when the caller enables them', () => {
    const setSemanticTargetPreference = vi.fn();
    const dispose = installMapE2eHooks({
      surveyLayer: () => ({
        enumerateGeometry: () => null,
        measuredPathDrawnCounts: () => ({ shots: 0, stations: 0 }),
        dragGhostOffset: () => null,
        setSemanticTargetPreference,
      }),
      toMeters: () => ({ x: 0, y: 0 }),
    });

    expect((window as HookWindow).__stalagmight_map_interaction__).toBeUndefined();
    expect((window as HookWindow).__stalagmight_set_map_target__).toBeUndefined();
    dispose();
  });

  it('forwards one-use targets and the interaction sequence when enabled', () => {
    const target = { featureType: 'station', sectionId: 4, stationIndex: 9 } as const;
    const setSemanticTarget = vi.fn(() => true);
    const dispose = installMapE2eHooks({
      surveyLayer: () => null,
      toMeters: () => ({ x: 0, y: 0 }),
      controls: {
        interactionSequence: () => 17,
        setSemanticTarget,
      },
    });

    expect((window as HookWindow).__stalagmight_map_interaction__?.()).toBe(17);
    expect((window as HookWindow).__stalagmight_set_map_target__?.(target)).toBe(true);
    expect(setSemanticTarget).toHaveBeenCalledWith(target);

    dispose();
    expect((window as HookWindow).__stalagmight_map_interaction__).toBeUndefined();
    expect((window as HookWindow).__stalagmight_set_map_target__).toBeUndefined();
  });
});
