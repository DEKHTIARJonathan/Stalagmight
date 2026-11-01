import { describe, expect, it, vi } from 'vitest';
import { reattachInOrder, watchGlContextLoss, type ReattachableLayer } from '../glContextRecovery';
import { makeFakeSurveyMap, type FakeSurveyMap } from '../../__tests__/surveyLayerFakeMap';

/**
 * Re-add `customIds` onto the stock-only stack the way MapLibre's addLayer would:
 * a beforeId that is not on the stack is refused (the layer is not added). Ids in
 * `noLand` have an owner whose re-add does nothing. Returns the final stack, the
 * calls made, and the refused adds.
 */
function run(
  order: string[],
  stockOnly: string[],
  customIds: string[],
  noLand: string[] = [],
): { stack: string[]; calls: Array<[string, string | undefined]>; refused: string[] } {
  const stack = [...stockOnly];
  const calls: Array<[string, string | undefined]> = [];
  const refused: string[] = [];
  const owners = new Map<string, ReattachableLayer>(
    customIds.map((id) => [
      id,
      {
        layerId: id,
        reattach: (beforeId) => {
          calls.push([id, beforeId]);
          if (noLand.includes(id)) return;
          const at = beforeId === undefined ? stack.length : stack.indexOf(beforeId);
          if (at < 0) refused.push(`${id} before ${beforeId}`);
          else stack.splice(at, 0, id);
        },
      },
    ]),
  );
  reattachInOrder(order, owners, (id) => stack.includes(id));
  return { stack, calls, refused };
}

const CUSTOM = ['survey-custom-render', 'survey-measure-path-custom', 'survey-custom-labels', 'survey-drag-ghost'];

describe('reattachInOrder', () => {
  it('rebuilds the exact pre-loss stack (the survey map shape)', () => {
    const order = [
      'background', 'satellite-tiles', 'grid-lines', 'survey-ghost-shots-hitbox', 'survey-loop-closures',
      'survey-custom-render', 'survey-measure-path-custom', 'survey-interact-shots', 'survey-interact-stations',
      'survey-custom-labels', 'survey-drag-ghost',
    ];
    const stockOnly = order.filter((id) => !CUSTOM.includes(id));
    expect(run(order, stockOnly, CUSTOM).stack).toEqual(order);
  });

  it('places adjacent custom layers relative to each other', () => {
    const order = ['a', 'c1', 'c2', 'c3', 'b'];
    const { stack, calls } = run(order, ['a', 'b'], ['c1', 'c2', 'c3']);
    expect(calls).toEqual([
      ['c3', 'b'],
      ['c2', 'c3'],
      ['c1', 'c2'],
    ]);
    expect(stack).toEqual(order);
  });

  it('skips a follower the restored style lacks, and custom ids that were not drawing', () => {
    const order = ['a', 'c1', 'gone', 'b'];
    const { calls } = run(order, ['a', 'b'], ['c1', 'c2']);
    expect(calls).toEqual([['c1', 'b']]);
  });

  // #576 D38 review RV1-FE-1: the insertion point is read off the live stack, so a
  // custom layer whose re-add did not land is skipped like a stock layer the
  // restored style lacks - the layer below goes before the next one that is there.
  it('places a layer before the next one that landed when the one above it did not', () => {
    const order = ['a', 'c1', 'c2', 'c3', 'b'];
    const { stack, calls, refused } = run(order, ['a', 'b'], ['c1', 'c2', 'c3'], ['c2']);
    expect(calls).toEqual([
      ['c3', 'b'],
      ['c2', 'c3'],
      ['c1', 'c3'],
    ]);
    expect(refused).toEqual([]);
    expect(stack).toEqual(['a', 'c1', 'c3', 'b']);
  });

  it('round-trips random stacks, with and without layers that do not land', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let trial = 0; trial < 200; trial++) {
      const ids = Array.from({ length: 3 + Math.floor(rnd() * 10) }, (_, i) => `l${i}`);
      ids.sort(() => rnd() - 0.5);
      const custom = ids.filter(() => rnd() < 0.4);
      const stockOnly = ids.filter((id) => !custom.includes(id));
      expect(run(ids, stockOnly, custom).stack).toEqual(ids);

      const noLand = custom.filter(() => rnd() < 0.3);
      const partial = run(ids, stockOnly, custom, noLand);
      expect(partial.refused).toEqual([]);
      expect(partial.stack).toEqual(ids.filter((id) => !noLand.includes(id)));
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

  // #576 D38 review RV1-FE-1: a custom layer whose re-add does not land (its
  // controller has nothing to draw any more, or the re-add failed and it tore
  // itself down) must not take the layer below it with it. Each insertion point is
  // chosen against the live map, so the survey geometry under the measured-path
  // tint goes back before the next layer that IS on the map, and MapLibre (which
  // refuses a beforeId that is not on the map, as the fake now does) accepts it.
  it('a layer whose re-add does not land does not take the one below it down', () => {
    const fake = makeFakeSurveyMap();
    for (const [id, type] of [
      ['background', 'background'],
      ['survey-loop-closures', 'line'],
      ['survey-custom-render', 'custom'],
      ['survey-measure-path-custom', 'custom'],
      ['survey-interact-shots', 'line'],
      ['survey-custom-labels', 'custom'],
    ] as const) {
      fake.map.addLayer({ id, type } as never);
    }
    const calls: string[] = [];
    const owners = [
      fakeOwner(fake, 'survey-custom-render', calls),
      // Nothing measured any more: its re-add is a no-op.
      { layerId: 'survey-measure-path-custom', reattach: () => {} },
      fakeOwner(fake, 'survey-custom-labels', calls),
    ];
    watchGlContextLoss(fake.map, { layers: () => owners, afterRestore: () => {} });

    loseContext(fake);
    fake.restoreStyle();
    fake.fire('webglcontextrestored');
    fake.fire('style.load');

    expect(fake.rejectedAdds()).toEqual([]);
    expect(fake.layerOrder()).toEqual([
      'background',
      'survey-loop-closures',
      'survey-custom-render',
      'survey-interact-shots',
      'survey-custom-labels',
    ]);
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
