/**
 * Unit test - `isAlreadyOpen` classifies the backend's ALREADY_OPEN rejection
 * across BOTH wire shapes Tauri can deliver a command error in (a raw string, or
 * an object with a `code` field). This is the dual-shape boundary the in-place
 * fast-forward / restore / take-remote swaps rely on to downgrade a non-error to
 * a debug log instead of an error-level ring/telemetry entry (agent-harness
 * campaign ws06/ws14/ws16). A regression that handled only one shape would
 * silently re-pollute the ring on the other.
 *
 * `.test.ts` runs in the node tier; mock the tauri core import so the pure
 * helper can be exercised without a tauri runtime.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { isAlreadyOpen } from './loadProjectBinary';

describe('isAlreadyOpen', () => {
  it('matches the string wire shape (substring)', () => {
    expect(isAlreadyOpen('ALREADY_OPEN')).toBe(true);
    expect(isAlreadyOpen('load_project_full_binary: ALREADY_OPEN: /a/b.stalx')).toBe(true);
  });

  it('matches the object wire shape (code field)', () => {
    expect(isAlreadyOpen({ code: 'ALREADY_OPEN' })).toBe(true);
    expect(isAlreadyOpen({ code: 'ALREADY_OPEN', message: 'already open' })).toBe(true);
  });

  it('is false for a different code, an unrelated string, and empty', () => {
    expect(isAlreadyOpen('Disk full')).toBe(false);
    expect(isAlreadyOpen('')).toBe(false);
    expect(isAlreadyOpen({ code: 'NOT_FOUND' })).toBe(false);
    expect(isAlreadyOpen({ message: 'ALREADY_OPEN' })).toBe(false); // code field only, not message
  });

  it('is false for null, undefined, and primitives', () => {
    expect(isAlreadyOpen(null)).toBe(false);
    expect(isAlreadyOpen(undefined)).toBe(false);
    expect(isAlreadyOpen(42)).toBe(false);
    expect(isAlreadyOpen(true)).toBe(false);
  });
});
