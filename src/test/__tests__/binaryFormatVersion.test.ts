import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Binary wire-format version tripwire (#27).
 *
 * The `load_project_full_binary` envelope carries a version that the frontend
 * decoder checks before trusting the payload. That version lives in THREE
 * places with nothing tying them together:
 *
 *   - `BINARY_FORMAT_VERSION` in `src-tauri/src/core/load_binary.rs`
 *   - `EXPECTED_VERSION` in `src/utils/loadProjectBinary.ts`
 *   - the hardcoded `version:` the Playwright mock puts in its envelope
 *
 * Bumping only the Rust side (as #27's ShotKind flags-byte change did) makes
 * every project load fail at runtime with "version mismatch: expected 2, got
 * 3". Nothing caught it: the Rust tests assert against the Rust constant, and
 * the frontend tests build their own envelopes rather than going through the
 * check. Same class of drift the mock-contract tripwire guards, so it gets the
 * same treatment - parse both sides and fail loudly.
 *
 * Note this pins that the two numbers AGREE, not what they are. A deliberate
 * format change bumps both and this test keeps passing, which is the point.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../');
const RUST_PATH = path.join(REPO_ROOT, 'src-tauri/src/core/load_binary.rs');
const TS_PATH = path.join(REPO_ROOT, 'src/utils/loadProjectBinary.ts');
const MOCK_PATH = path.join(REPO_ROOT, 'e2e-playwright/mocks/tauri-ipc.ts');

function parseRustVersion(source: string): number {
  const match = /pub const BINARY_FORMAT_VERSION:\s*u32\s*=\s*(\d+)\s*;/.exec(source);
  if (!match) {
    throw new Error(
      'Could not find `pub const BINARY_FORMAT_VERSION: u32 = N;` in load_binary.rs. ' +
        'If it was renamed or moved, update this tripwire to match.',
    );
  }
  return Number(match[1]);
}

function parseTsVersion(source: string): number {
  const match = /const EXPECTED_VERSION\s*=\s*(\d+)\s*;/.exec(source);
  if (!match) {
    throw new Error(
      'Could not find `const EXPECTED_VERSION = N;` in loadProjectBinary.ts. ' +
        'If it was renamed or moved, update this tripwire to match.',
    );
  }
  return Number(match[1]);
}

function parseMockVersion(source: string): number {
  // The mock builds exactly one envelope; its `version:` sits directly above
  // the `loading_id` field.
  const match = /version:\s*(\d+),\s*\n\s*loading_id:/.exec(source);
  if (!match) {
    throw new Error(
      'Could not find the mock envelope\'s `version: N,` above `loading_id:` in ' +
        'e2e-playwright/mocks/tauri-ipc.ts. If the envelope was restructured, update ' +
        'this tripwire to match.',
    );
  }
  return Number(match[1]);
}

describe('binary wire-format version contract', () => {
  it('the Rust encoder and the TS decoder agree on the envelope version', () => {
    const rustVersion = parseRustVersion(fs.readFileSync(RUST_PATH, 'utf8'));
    const tsVersion = parseTsVersion(fs.readFileSync(TS_PATH, 'utf8'));

    expect(
      tsVersion,
      `Binary wire-format version drift: Rust encodes v${rustVersion} but the frontend ` +
        `decoder expects v${tsVersion}, so every project load would fail with a version ` +
        'mismatch. Bump BINARY_FORMAT_VERSION (load_binary.rs) and EXPECTED_VERSION ' +
        '(loadProjectBinary.ts) together.',
    ).toBe(rustVersion);
  });

  it('the Playwright mock encodes the same envelope version', () => {
    // A stale mock version makes every Playwright spec that loads a project
    // fail on the decoder's version gate, which looks like a broken feature
    // rather than a stale fixture.
    const rustVersion = parseRustVersion(fs.readFileSync(RUST_PATH, 'utf8'));
    const mockVersion = parseMockVersion(fs.readFileSync(MOCK_PATH, 'utf8'));

    expect(
      mockVersion,
      `The Playwright mock encodes binary envelope v${mockVersion} but Rust encodes ` +
        `v${rustVersion}. Update the \`version:\` in e2e-playwright/mocks/tauri-ipc.ts.`,
    ).toBe(rustVersion);
  });
});
