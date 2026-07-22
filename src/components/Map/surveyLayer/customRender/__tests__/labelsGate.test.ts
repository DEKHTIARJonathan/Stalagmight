import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readCustomLabelsGate,
  CUSTOM_LABELS_STORAGE_KEY,
  CUSTOM_LABELS_WINDOW_KEY,
  CUSTOM_LABELS_SYNC_HOOK,
} from '../labelsGate';

/**
 * Labels gate (#customRender labels, Phase 2). Cloned from `gate.ts`; the node
 * env has no window / localStorage, so these stub the two globals to exercise the
 * override-wins / persisted / default-OFF branches.
 */
afterEach(() => vi.unstubAllGlobals());

describe('readCustomLabelsGate', () => {
  it('defaults OFF with no window / localStorage', () => {
    expect(readCustomLabelsGate()).toBe(false);
  });

  it('reads localStorage "1" / "true" as ON, anything else OFF', () => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null });
    expect(readCustomLabelsGate()).toBe(false);
    store[CUSTOM_LABELS_STORAGE_KEY] = '1';
    expect(readCustomLabelsGate()).toBe(true);
    store[CUSTOM_LABELS_STORAGE_KEY] = 'true';
    expect(readCustomLabelsGate()).toBe(true);
    store[CUSTOM_LABELS_STORAGE_KEY] = '0';
    expect(readCustomLabelsGate()).toBe(false);
  });

  it('a boolean window override wins over the persisted value', () => {
    const store: Record<string, string> = { [CUSTOM_LABELS_STORAGE_KEY]: '1' };
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null });
    vi.stubGlobal('window', { [CUSTOM_LABELS_WINDOW_KEY]: false });
    expect(readCustomLabelsGate()).toBe(false); // live false beats stored '1'
    vi.stubGlobal('window', { [CUSTOM_LABELS_WINDOW_KEY]: true });
    expect(readCustomLabelsGate()).toBe(true);
  });

  it('ignores a non-boolean window override (falls through to localStorage)', () => {
    vi.stubGlobal('window', { [CUSTOM_LABELS_WINDOW_KEY]: 'yes' });
    vi.stubGlobal('localStorage', { getItem: () => '1' });
    expect(readCustomLabelsGate()).toBe(true);
  });

  it('treats a throwing localStorage as OFF', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('locked down');
      },
    });
    expect(readCustomLabelsGate()).toBe(false);
  });

  it('uses keys/hook distinct from the geometry gate', () => {
    expect(CUSTOM_LABELS_STORAGE_KEY).toBe('stalagmight_custom_labels');
    expect(CUSTOM_LABELS_WINDOW_KEY).toBe('__stalagmight_custom_labels__');
    expect(CUSTOM_LABELS_SYNC_HOOK).toBe('__stalagmightSyncCustomLabels');
  });
});
