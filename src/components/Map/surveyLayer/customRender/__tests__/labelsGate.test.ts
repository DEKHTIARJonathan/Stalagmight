import { describe, expect, it } from 'vitest';
import { CUSTOM_LABELS_SYNC_HOOK } from '../labelsGate';

/**
 * Labels gate module (#customRender labels). The custom WebGL label renderer is
 * now the SOLE label path - there is no gate and no opt-out machinery. All that
 * survives is the runtime re-sync hook name; assert it is stable + distinct from
 * the geometry hook (controllers and the agent bridge key off it).
 */
describe('labelsGate module', () => {
  it('exposes only the stable re-sync hook name (no gate reader / keys)', () => {
    expect(CUSTOM_LABELS_SYNC_HOOK).toBe('__stalagmightSyncCustomLabels');
  });

  it('the labels hook is distinct from the geometry hook', async () => {
    const { CUSTOM_RENDER_SYNC_HOOK } = await import('../gate');
    expect(CUSTOM_LABELS_SYNC_HOOK).not.toBe(CUSTOM_RENDER_SYNC_HOOK);
  });
});
