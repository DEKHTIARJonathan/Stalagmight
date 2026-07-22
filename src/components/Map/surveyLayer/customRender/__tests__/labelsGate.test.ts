import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readCustomLabelsGate,
  CUSTOM_LABELS_STORAGE_KEY,
  CUSTOM_LABELS_WINDOW_KEY,
  CUSTOM_LABELS_SYNC_HOOK,
} from '../labelsGate';

/**
 * Labels gate (#customRender labels). The custom label renderer is now the
 * default (and only) label path: default ON when a DOM is present, OFF only in a
 * non-DOM env or when explicitly opted out. The node test env has no window /
 * localStorage, so these stub the two globals to exercise the DOM branches.
 */
afterEach(() => vi.unstubAllGlobals());

describe('readCustomLabelsGate', () => {
  it('reads as OFF with no DOM (node/test env) so gate-less controllers stay inert', () => {
    expect(readCustomLabelsGate()).toBe(false);
  });

  it('defaults ON when a DOM is present and nothing is set', () => {
    vi.stubGlobal('window', {});
    expect(readCustomLabelsGate()).toBe(true);
  });

  it('explicit opt-out via localStorage "0" / "false"; anything else stays default ON', () => {
    const store: Record<string, string> = {};
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null });
    expect(readCustomLabelsGate()).toBe(true); // unset → default ON
    store[CUSTOM_LABELS_STORAGE_KEY] = '0';
    expect(readCustomLabelsGate()).toBe(false);
    store[CUSTOM_LABELS_STORAGE_KEY] = 'false';
    expect(readCustomLabelsGate()).toBe(false);
    store[CUSTOM_LABELS_STORAGE_KEY] = '1';
    expect(readCustomLabelsGate()).toBe(true); // not an opt-out value → default ON
  });

  it('a boolean window override wins over the persisted value and the default', () => {
    const store: Record<string, string> = { [CUSTOM_LABELS_STORAGE_KEY]: '0' };
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null });
    vi.stubGlobal('window', { [CUSTOM_LABELS_WINDOW_KEY]: true });
    expect(readCustomLabelsGate()).toBe(true); // live true beats stored '0'
    vi.stubGlobal('window', { [CUSTOM_LABELS_WINDOW_KEY]: false });
    expect(readCustomLabelsGate()).toBe(false); // live false opts out
  });

  it('ignores a non-boolean window override (falls through to localStorage)', () => {
    vi.stubGlobal('window', { [CUSTOM_LABELS_WINDOW_KEY]: 'yes' });
    vi.stubGlobal('localStorage', { getItem: () => '0' });
    expect(readCustomLabelsGate()).toBe(false); // non-boolean ignored → localStorage '0' opts out
  });

  it('treats a throwing localStorage (DOM present) as the default ON', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('locked down');
      },
    });
    expect(readCustomLabelsGate()).toBe(true);
  });

  it('uses keys/hook distinct from the geometry gate', () => {
    expect(CUSTOM_LABELS_STORAGE_KEY).toBe('stalagmight_custom_labels');
    expect(CUSTOM_LABELS_WINDOW_KEY).toBe('__stalagmight_custom_labels__');
    expect(CUSTOM_LABELS_SYNC_HOOK).toBe('__stalagmightSyncCustomLabels');
  });
});
