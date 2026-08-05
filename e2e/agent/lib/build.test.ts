/**
 * Unit tests for the agent-harness build-freshness decision (issue #260): the
 * E2E build stamp must make a hookless binary look STALE *before* attach, and
 * an E2E binary the harness itself built must still look fresh (no
 * always-rebuild regression). Since #421 the stamp also records whether the
 * binary carries the e2e cargo feature (the in-app WebDriver plugin macOS
 * needs), and a v1 stamp reads as no stamp at all.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBuildStamp, stampStaleReasons, type E2EBuildStamp } from './build';

const E2E_STAMP: E2EBuildStamp = {
  v: 2,
  viteE2E: true,
  e2eFeature: false,
  viteMode: 'production',
  binaryMtimeMs: 1_700_000_000_000,
  builtAtMs: 1_700_000_000_500,
  builtAtIso: '2023-11-14T22:13:20.500Z',
};

const wantMatching = {
  viteE2E: true,
  e2eFeature: false,
  binaryMtimeMs: E2E_STAMP.binaryMtimeMs,
};

describe('stampStaleReasons', () => {
  it('treats a missing stamp as stale (binary not built by the harness)', () => {
    const reasons = stampStaleReasons(null, { viteE2E: true, e2eFeature: false, binaryMtimeMs: 1 });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('no E2E build stamp');
  });

  it('treats a non-E2E stamp as stale when the start needs the hooks', () => {
    const stamp = { ...E2E_STAMP, viteE2E: false };
    const reasons = stampStaleReasons(stamp, wantMatching);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('VITE_E2E=0');
  });

  it('treats an E2E stamp as stale when the start does NOT want the hooks', () => {
    const reasons = stampStaleReasons(E2E_STAMP, { ...wantMatching, viteE2E: false });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('VITE_E2E=1');
  });

  it('treats a plugin-less binary as stale when the platform needs the e2e feature', () => {
    const reasons = stampStaleReasons(E2E_STAMP, { ...wantMatching, e2eFeature: true });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('e2e cargo feature');
    expect(reasons[0]).toContain('off');
  });

  it('treats a feature build as stale when the platform wants it off', () => {
    const stamp = { ...E2E_STAMP, e2eFeature: true };
    const reasons = stampStaleReasons(stamp, wantMatching);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('e2e cargo feature');
    expect(reasons[0]).toContain('on');
  });

  it('treats a binary rebuilt behind our back as stale', () => {
    const reasons = stampStaleReasons(E2E_STAMP, {
      ...wantMatching,
      binaryMtimeMs: E2E_STAMP.binaryMtimeMs + 1000,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('rebuilt outside the harness');
  });

  it('accepts a matching E2E stamp (no rebuild - the whole point)', () => {
    expect(stampStaleReasons(E2E_STAMP, wantMatching)).toEqual([]);
  });

  it('accepts a matching feature-build stamp', () => {
    const stamp = { ...E2E_STAMP, e2eFeature: true };
    expect(stampStaleReasons(stamp, { ...wantMatching, e2eFeature: true })).toEqual([]);
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
    expect(readBuildStamp(write(JSON.stringify({ ...E2E_STAMP, v: 3 })))).toBeNull();
  });

  it('returns null for a v1 stamp (predates e2eFeature - one forced rebuild)', () => {
    const v1 = { ...E2E_STAMP, v: 1 } as Record<string, unknown>;
    delete v1['e2eFeature'];
    expect(readBuildStamp(write(JSON.stringify(v1)))).toBeNull();
  });

  it('returns null when the required fields have the wrong type', () => {
    expect(readBuildStamp(write(JSON.stringify({ ...E2E_STAMP, viteE2E: 'yes' })))).toBeNull();
    expect(readBuildStamp(write(JSON.stringify({ ...E2E_STAMP, e2eFeature: 'on' })))).toBeNull();
    expect(readBuildStamp(write(JSON.stringify({ ...E2E_STAMP, binaryMtimeMs: null })))).toBeNull();
  });

  it('round-trips a well-formed stamp', () => {
    expect(readBuildStamp(write(JSON.stringify(E2E_STAMP)))).toEqual(E2E_STAMP);
  });

  it('a stamp read back from disk is accepted against its own binary mtime', () => {
    const stamp = readBuildStamp(write(JSON.stringify(E2E_STAMP)));
    expect(stamp).not.toBeNull();
    expect(stampStaleReasons(stamp, wantMatching)).toEqual([]);
  });
});
