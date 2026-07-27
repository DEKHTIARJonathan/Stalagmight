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

/**
 * Field names of a Rust struct / TS interface / JS object literal, given the source
 * and the line that opens the block. All three parsers slice from that opener to the
 * matching close and read one level of keys - nested blocks are skipped by brace
 * depth, so `project_header`'s own fields never leak into the top-level set.
 */
function fieldsInBlock(
  source: string,
  opener: RegExp,
  keyPattern: RegExp,
  what: string,
): string[] {
  const open = opener.exec(source);
  if (!open) {
    throw new Error(
      `Could not find ${what}. If it was renamed or restructured, update this tripwire to match.`,
    );
  }
  const body = source.slice(open.index + open[0].length);
  const fields: string[] = [];
  let depth = 0;
  for (const line of body.split('\n')) {
    // Read keys only at the block's own level; a nested struct/object/array
    // contributes nothing but its brace deltas.
    if (depth === 0) {
      const key = keyPattern.exec(line);
      if (key?.[1]) fields.push(key[1]);
    }
    for (const ch of line) {
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') depth -= 1;
    }
    if (depth < 0) return fields; // hit the block's closing brace
  }
  throw new Error(`${what} does not terminate - update this tripwire to match.`);
}

function parseRustEnvelopeFields(source: string): string[] {
  return fieldsInBlock(
    source,
    /pub struct LoadProjectFullBinaryResult \{\n/,
    /^\s*pub ([a-z_][a-z0-9_]*):/,
    '`pub struct LoadProjectFullBinaryResult {` in load_binary.rs',
  );
}

function parseTsEnvelopeFields(source: string): string[] {
  return fieldsInBlock(
    source,
    /export interface BinaryEnvelope \{\n/,
    /^\s*([a-z_][a-z0-9_]*)\??:/,
    '`export interface BinaryEnvelope {` in loadProjectBinary.ts',
  );
}

function parseMockEnvelopeKeys(source: string): string[] {
  return fieldsInBlock(
    source,
    /const envelope = \{\n/,
    /^\s*([a-z_][a-z0-9_]*):/,
    '`const envelope = {` in e2e-playwright/mocks/tauri-ipc.ts',
  );
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

  it('the TS decoder and the Playwright mock carry every envelope field Rust sends', () => {
    // The version check above pins the NUMBER, not the FIELD SET, and that gap has
    // already cost us once: `is_remote` was added to the envelope at v3, the mock
    // never grew it, and because the decoder reads it unvalidated every mocked load
    // resolved `isRemote: undefined`. Once `selectSpeleoReadOnly` was inverted to
    // fail closed (#270) that silently opened the SpeleoDB read-only gate across the
    // entire Playwright suite, with the version tripwire green throughout. A field
    // added to the Rust envelope is exactly as breaking as a layout change, so it
    // gets the same treatment.
    const rustFields = parseRustEnvelopeFields(fs.readFileSync(RUST_PATH, 'utf8'));
    const tsFields = parseTsEnvelopeFields(fs.readFileSync(TS_PATH, 'utf8'));
    const mockKeys = parseMockEnvelopeKeys(fs.readFileSync(MOCK_PATH, 'utf8'));

    // Sanity-anchor the parses before trusting the set comparisons: an empty or
    // truncated slice would make every `toContain` below vacuously easy to satisfy
    // in the one direction that matters.
    expect(rustFields.length).toBeGreaterThan(10);
    expect(tsFields.length).toBeGreaterThan(10);
    expect(mockKeys.length).toBeGreaterThan(10);

    const missingFromTs = rustFields.filter((f) => !tsFields.includes(f));
    expect(
      missingFromTs,
      `The Rust envelope (LoadProjectFullBinaryResult in load_binary.rs) carries field(s) ` +
        `[${missingFromTs.join(', ')}] that \`BinaryEnvelope\` in src/utils/loadProjectBinary.ts ` +
        'does not declare, so the decoder drops them silently. Add them to BinaryEnvelope.',
    ).toEqual([]);

    const missingFromMock = rustFields.filter((f) => !mockKeys.includes(f));
    expect(
      missingFromMock,
      `The Rust envelope carries field(s) [${missingFromMock.join(', ')}] that the Playwright ` +
        'mock envelope in e2e-playwright/mocks/tauri-ipc.ts does not set, so every mocked ' +
        'project load resolves them as `undefined` - which reads as a broken feature rather ' +
        'than a stale fixture. Add them to the mock envelope literal.',
    ).toEqual([]);
  });
});
