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
import {
  isPluginAclChurn,
  needsE2eFeature,
  readBuildStamp,
  stampStaleReasons,
  type E2EBuildStamp,
} from './build';

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

// Pins the wiring between the platform selector and the freshness decision: a
// regression hardcoding e2eFeature:false in checkBuildFreshness's `want` would
// otherwise pass every stamp test and recreate the silent mac session-create
// hang the v2 stamp exists to prevent.
describe('needsE2eFeature', () => {
  const KEY = 'STALAGMIGHT_AGENT_PLATFORM';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('is true when the target platform is darwin', () => {
    process.env[KEY] = 'darwin';
    expect(needsE2eFeature()).toBe(true);
  });

  it('is false when the target platform is linux', () => {
    process.env[KEY] = 'linux';
    expect(needsE2eFeature()).toBe(false);
  });

  it('follows the real platform when no override is set', () => {
    delete process.env[KEY];
    expect(needsE2eFeature()).toBe(process.platform === 'darwin');
  });
});

// The restore guard must recover from an INTERRUPTED feature build (killed
// smoke, ctrl-c) - which leaves churn behind with nothing to time it against -
// while never discarding a real edit to the generated schemas.
describe('isPluginAclChurn', () => {
  const churn = [
    'diff --git a/src-tauri/gen/schemas/macOS-schema.json b/src-tauri/gen/schemas/macOS-schema.json',
    '--- a/src-tauri/gen/schemas/macOS-schema.json',
    '+++ b/src-tauri/gen/schemas/macOS-schema.json',
    '@@ -1,3 +1,4 @@',
    '   "existing": true,',
    '+  "webdriver-automation:allow-element-find",',
    '+  "webdriver-automation:default"',
  ].join('\n');

  it('accepts a diff whose additions are all plugin ACL entries', () => {
    expect(isPluginAclChurn(churn)).toBe(true);
  });

  it('rejects a diff carrying any unrelated addition', () => {
    expect(isPluginAclChurn(`${churn}\n+  "someone-elses:real-permission"`)).toBe(false);
  });

  it('rejects an empty diff (nothing to restore is not churn)', () => {
    expect(isPluginAclChurn('')).toBe(false);
  });

  // The feature build only ADDS entries, so a removal proves a human edited
  // these files - restoring would discard their work.
  it('rejects a diff containing any removal, even when every addition is churn', () => {
    expect(isPluginAclChurn(`${churn}\n-  "someone-elses:deleted-permission"`)).toBe(false);
  });

  it('does not mistake the --- file header for a removal', () => {
    expect(isPluginAclChurn(churn)).toBe(true);
  });

  it('ignores the +++ file header, which is not an added line', () => {
    const headerOnly = ['--- a/x.json', '+++ b/x.json'].join('\n');
    expect(isPluginAclChurn(headerOnly)).toBe(false);
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
