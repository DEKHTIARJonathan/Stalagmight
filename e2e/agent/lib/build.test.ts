/**
 * Unit tests for the agent-harness build-freshness decision (issue #260): the
 * E2E build stamp must make a hookless binary look STALE *before* attach, and
 * an E2E binary the harness itself built must still look fresh (no
 * always-rebuild regression).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBuildStamp, stampStaleReasons, type E2EBuildStamp } from './build';

const E2E_STAMP: E2EBuildStamp = {
  v: 1,
  viteE2E: true,
  viteMode: 'production',
  binaryMtimeMs: 1_700_000_000_000,
  builtAtMs: 1_700_000_000_500,
  builtAtIso: '2023-11-14T22:13:20.500Z',
};

describe('stampStaleReasons', () => {
  it('treats a missing stamp as stale (binary not built by the harness)', () => {
    const reasons = stampStaleReasons(null, { viteE2E: true, binaryMtimeMs: 1 });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('no E2E build stamp');
  });

  it('treats a non-E2E stamp as stale when the start needs the hooks', () => {
    const stamp = { ...E2E_STAMP, viteE2E: false };
    const reasons = stampStaleReasons(stamp, {
      viteE2E: true,
      binaryMtimeMs: stamp.binaryMtimeMs,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('VITE_E2E=0');
  });

  it('treats an E2E stamp as stale when the start does NOT want the hooks', () => {
    const reasons = stampStaleReasons(E2E_STAMP, {
      viteE2E: false,
      binaryMtimeMs: E2E_STAMP.binaryMtimeMs,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('VITE_E2E=1');
  });

  it('treats a binary rebuilt behind our back as stale', () => {
    const reasons = stampStaleReasons(E2E_STAMP, {
      viteE2E: true,
      binaryMtimeMs: E2E_STAMP.binaryMtimeMs + 1000,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('rebuilt outside the harness');
  });

  it('accepts a matching E2E stamp (no rebuild - the whole point)', () => {
    expect(
      stampStaleReasons(E2E_STAMP, {
        viteE2E: true,
        binaryMtimeMs: E2E_STAMP.binaryMtimeMs,
      }),
    ).toEqual([]);
  });
});

describe('readBuildStamp', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-stamp-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(contents: string): string {
    const file = path.join(dir, 'stamp.json');
    fs.writeFileSync(file, contents);
    return file;
  }

  it('returns null for a missing file', () => {
    expect(readBuildStamp(path.join(dir, 'nope.json'))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(readBuildStamp(write('{ not json'))).toBeNull();
  });

  it('returns null for an unknown schema version', () => {
    expect(readBuildStamp(write(JSON.stringify({ ...E2E_STAMP, v: 2 })))).toBeNull();
  });

  it('returns null when the required fields have the wrong type', () => {
    expect(readBuildStamp(write(JSON.stringify({ ...E2E_STAMP, viteE2E: 'yes' })))).toBeNull();
    expect(readBuildStamp(write(JSON.stringify({ ...E2E_STAMP, binaryMtimeMs: null })))).toBeNull();
  });

  it('round-trips a well-formed stamp', () => {
    expect(readBuildStamp(write(JSON.stringify(E2E_STAMP)))).toEqual(E2E_STAMP);
  });

  it('a stamp read back from disk is accepted against its own binary mtime', () => {
    const stamp = readBuildStamp(write(JSON.stringify(E2E_STAMP)));
    expect(stamp).not.toBeNull();
    expect(
      stampStaleReasons(stamp, { viteE2E: true, binaryMtimeMs: E2E_STAMP.binaryMtimeMs }),
    ).toEqual([]);
  });
});
