// Third-party license bundle staleness gate (issue #226).
//
// THIRD-PARTY-LICENSES.md is generated from the two dependency lockfiles by
// scripts/gen-third-party-licenses.mjs, which embeds a sha256 of each lockfile
// in an HTML comment. This gate recomputes those hashes and fails on mismatch,
// so a dependency change cannot merge without regenerating the attribution
// bundle the shipped app carries.
//
// A pure hash comparison on purpose: regeneration needs cargo-about installed
// and a populated node_modules, which CI's check job should not pay for on
// every push. The hash pins the full lockfile, so a devDependency-only change
// also asks for a regen - that run is a no-op diff, and the alternative
// (hashing only the prod subset) would mean reimplementing pnpm's prod-graph
// resolution here just to save one local command.
//
// Usage:  node scripts/check-third-party-licenses.mjs   (or: pnpm lint:third-party)
// Regenerate:  pnpm gen:third-party
//   (needs: cargo install cargo-about --locked --features cli)

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BUNDLE = 'THIRD-PARTY-LICENSES.md';
const LOCKFILES = ['src-tauri/Cargo.lock', 'pnpm-lock.yaml'];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Returns a list of problem strings; empty means the bundle is current.
export function checkBundle(root) {
  let body;
  try {
    body = fs.readFileSync(path.join(root, BUNDLE), 'utf8');
  } catch {
    return [`${BUNDLE} is missing`];
  }
  const comment = body.match(/<!-- lockfile-hashes\n([\s\S]*?)-->/);
  if (!comment) return [`${BUNDLE} has no lockfile-hashes comment - regenerate it`];
  const recorded = new Map(
    [...comment[1].matchAll(/^(\S+)=([0-9a-f]{64})$/gm)].map((m) => [m[1], m[2]]),
  );
  const problems = [];
  for (const rel of LOCKFILES) {
    const want = recorded.get(path.posix.basename(rel));
    if (!want) {
      problems.push(`${BUNDLE} records no hash for ${rel} - regenerate it`);
      continue;
    }
    const got = sha256(fs.readFileSync(path.join(root, rel)));
    if (got !== want) problems.push(`${rel} changed since ${BUNDLE} was generated`);
  }
  return problems;
}

function main() {
  const problems = checkBundle(REPO_ROOT);
  if (problems.length === 0) {
    console.log(`✓ ${BUNDLE} matches both lockfiles`);
    return;
  }
  for (const p of problems) console.error(`✗ ${p}`);
  console.error(
    '\nRegenerate the third-party attribution bundle:\n' +
      '  pnpm gen:third-party\n' +
      '(needs cargo-about: cargo install cargo-about --locked --features cli)',
  );
  process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
