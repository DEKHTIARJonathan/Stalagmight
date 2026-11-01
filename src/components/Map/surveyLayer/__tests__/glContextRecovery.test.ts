import { describe, expect, it, vi } from 'vitest';
import { reattachPlan, watchGlContextLoss, type ReattachableLayer } from '../glContextRecovery';
import { makeFakeSurveyMap, type FakeSurveyMap } from '../../__tests__/surveyLayerFakeMap';

/** Apply a plan to the stock-only order the way MapLibre's addLayer would. */
function apply(stockOnly: string[], plan: Array<{ id: string; beforeId: string | undefined }>): string[] {
  const out = [...stockOnly];
  for (const { id, beforeId } of plan) {
    const at = beforeId === undefined ? -1 : out.indexOf(beforeId);
    if (at >= 0) out.splice(at, 0, id);
    else out.push(id);
  }
  return out;
}

const CUSTOM = ['survey-custom-render', 'survey-measure-path-custom', 'survey-custom-labels', 'survey-drag-ghost'];

describe('reattachPlan', () => {
  it('rebuilds the exact pre-loss stack (the survey map shape)', () => {
    const order = [
      'background', 'satellite-tiles', 'grid-lines', 'survey-ghost-shots-hitbox', 'survey-loop-closures',
      'survey-custom-render', 'survey-measure-path-custom', 'survey-interact-shots', 'survey-interact-stations',
      'survey-custom-labels', 'survey-drag-ghost',
    ];
    const stockOnly = order.filter((id) => !CUSTOM.includes(id));
    const plan = reattachPlan(order, CUSTOM, (id) => stockOnly.includes(id));
    expect(apply(stockOnly, plan)).toEqual(order);
  });

  it('places adjacent custom layers relative to each other', () => {
    const order = ['a', 'c1', 'c2', 'c3', 'b'];
    const stockOnly = ['a', 'b'];
    const plan = reattachPlan(order, ['c1', 'c2', 'c3'], (id) => stockOnly.includes(id));
    expect(plan).toEqual([
      { id: 'c3', beforeId: 'b' },
      { id: 'c2', beforeId: 'c3' },
      { id: 'c1', beforeId: 'c2' },
    ]);
    expect(apply(stockOnly, plan)).toEqual(order);
  });

  it('skips a follower the restored style lacks, and custom ids that were not drawing', () => {
    const order = ['a', 'c1', 'gone', 'b'];
    const plan = reattachPlan(order, ['c1', 'c2'], (id) => id === 'a' || id === 'b');
    expect(plan).toEqual([{ id: 'c1', beforeId: 'b' }]);
  });

  it('round-trips random stacks', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let trial = 0; trial < 200; trial++) {
      const ids = Array.from({ length: 3 + Math.floor(rnd() * 10) }, (_, i) => `l${i}`);
      ids.sort(() => rnd() - 0.5);
      const custom = ids.filter(() => rnd() < 0.4);
      const stockOnly = ids.filter((id) => !custom.includes(id));
      const plan = reattachPlan(ids, custom, (id) => stockOnly.includes(id));
      expect(apply(stockOnly, plan)).toEqual(ids);
    }
  });
});

/** A controller stand-in: re-adds its layer as a custom layer, recording the call. */
function fakeOwner(fake: FakeSurveyMap, layerId: string, calls: string[]): ReattachableLayer {
  return {
    layerId,
    reattach: (beforeId) => {
      calls.push(`${layerId}<${beforeId ?? 'top'}`);
      fake.map.addLayer({ id: layerId, type: 'custom' } as never, beforeId);
    },
  };
}

function setUp() {
  const fake = makeFakeSurveyMap();
  for (const id of ['background', 'survey-loop-closures']) fake.map.addLayer({ id, type: 'line' } as never);
  fake.map.addLayer({ id: 'survey-custom-render', type: 'custom' } as never);
  fake.map.addLayer({ id: 'survey-interact-shots', type: 'line' } as never);
  fake.map.addLayer({ id: 'survey-custom-labels', type: 'custom' } as never);
  const calls: string[] = [];
  const owners = [fakeOwner(fake, 'survey-custom-render', calls), fakeOwner(fake, 'survey-custom-labels', calls)];
  const afterRestore = vi.fn();
  const beforeLoss = vi.fn();
  const detach = watchGlContextLoss(fake.map, { layers: () => owners, beforeLoss, afterRestore });
  return { fake, calls, afterRestore, beforeLoss, detach };
}

/** MapLibre's sequence: the canvas event (capture runs first, style alive),
 *  then MapLibre tears the style down and fires its own map event. */
function loseContext(fake: FakeSurveyMap): void {
  fake.container.dispatchEvent(new Event('webglcontextlost'));
  fake.loseStyle();
  fake.fire('webglcontextlost');
}

describe('watchGlContextLoss', () => {
  it('re-adds the custom layers at their old positions once the restored style loads', () => {
    const { fake, calls, afterRestore, beforeLoss } = setUp();
    const before = fake.layerOrder();

    loseContext(fake);
    expect(beforeLoss).toHaveBeenCalledOnce();
    expect(fake.customLayers()).toEqual([]);

    fake.restoreStyle();
    fake.fire('webglcontextrestored');
    // The restored style loads on the next frame; adding before that would throw.
    expect(calls).toEqual([]);

    fake.fire('style.load');
    expect(calls).toEqual(['survey-custom-labels<top', 'survey-custom-render<survey-interact-shots']);
    expect(fake.layerOrder()).toEqual(before);
    expect(afterRestore).toHaveBeenCalledOnce();
  });

  it('ignores a restore without a loss, and later style loads', () => {
    const { fake, calls, afterRestore } = setUp();
    fake.fire('webglcontextrestored');
    fake.fire('style.load');
    loseContext(fake);
    fake.restoreStyle();
    fake.fire('webglcontextrestored');
    fake.fire('style.load');
    fake.fire('style.load');
    expect(calls).toHaveLength(2);
    expect(afterRestore).toHaveBeenCalledOnce();
  });

  it('detach removes every listener, including a pending style-load', () => {
    const { fake, calls, afterRestore, detach } = setUp();
    loseContext(fake);
    fake.restoreStyle();
    fake.fire('webglcontextrestored');
    detach();
    fake.fire('style.load');
    expect(calls).toEqual([]);
    expect(afterRestore).not.toHaveBeenCalled();
    expect(fake.listenerCount('webglcontextlost')).toBe(0);
    expect(fake.listenerCount('webglcontextrestored')).toBe(0);
    expect(fake.listenerCount('style.load')).toBe(0);
    expect(fake.container.listenerCount('webglcontextlost')).toBe(0);
  });
});
