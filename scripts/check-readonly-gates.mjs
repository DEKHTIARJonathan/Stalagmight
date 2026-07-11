// Canonical read-only gating tripwire (#275).
//
// The correct "is the survey map read-only right now" predicate is
// `isMapReadOnly(state)` (geometryMode === 'closureAdjusted' || appMode !== 'survey'),
// composed with `speleoReadOnly` (selectSpeleoReadOnly) for a locked remote SpeleoDB
// project. Two recurring bug classes keep re-appearing at individual call sites:
//
//   (A) a RAW `geometryMode === 'closureAdjusted'` comparison used as a mutation
//       gate. This is wrong whenever appMode !== 'survey': Plan/Export force
//       closureAdjusted, but that auto-reverts to 'measured' on a project with no
//       eligible closures — so a geometryMode-only check silently reports
//       "editable" in a workspace that must be read-only (#243 / the #225 bug
//       class). `DataTable.tsx`, `SectionsPanel.tsx`, `WarningResolution.tsx`,
//       `DetailPanel.tsx`, and `CollabReviewDialog.tsx` all had exactly this bug;
//       fixed in #275.
//
//   (B) a call site that reads `isMapReadOnly` but never composes it with
//       `speleoReadOnly` — a locked remote project then looks editable in the UI
//       even though the backend `guard_mutation` will reject the write (the
//       backend fails safe; this is a UI-tier bug, not a data-safety one).
//
// This script is a curated allowlist, not a mechanical LOC ratchet (#157's
// pattern) — the legitimate raw-comparison sites (display/coordinate-selection
// logic, the isMapReadOnly definition itself, the geometry-mode radio control)
// are enumerated by hand below, each with why it's fine. Anything beyond that
// baseline count, in a file already on the list or a brand new file, fails the
// gate. Rule (B) similarly allowlists (empty today) any `isMapReadOnly`-using
// file that legitimately doesn't need `speleoReadOnly`.
//
// Usage:  node scripts/check-readonly-gates.mjs   (or: pnpm lint:readonly-gates)

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Rule (A): file -> max allowed count of a raw `=== 'closureAdjusted'` /
// `=== "closureAdjusted"` comparison. Each entry is a reviewed, legitimate
// non-mutation usage (display/coordinate-selection, or the canonical
// definition) — not a mutation gate that should instead compose isMapReadOnly.
export const CLOSURE_ADJUSTED_ALLOWLIST = {
  // The geometry-mode radio control itself: this IS the setting, not a gate.
  'src/components/SingleSystemView/DisplayMenu.tsx': 2,
  // Adjusted-geometry data-fetch trigger, the auto-revert-to-measured logic (the
  // very mechanism the appMode trap above exists because of), and the read-only
  // banner display — none are mutation gates.
  'src/components/Map/MapCanvas.tsx': 4,
  // Guarded by an outer `appMode !== 'survey'` branch a few lines up, so the raw
  // geometryMode check is already scoped to appMode === 'survey' — equivalent to
  // isMapReadOnly there.
  'src/components/common/ContextMenu.tsx': 1,
  // Coordinate-set selection (which station/survey-data array to render), not a
  // mutation gate.
  'src/store/geometrySelectors.ts': 2,
  // The canonical definition of isMapReadOnly, plus two settings-value
  // sanitizers (validating/loading a persisted enum) — not mutation gates.
  'src/store/uiStore.ts': 3,
};

// Rule (B): files allowed to use `isMapReadOnly` without also composing
// `speleoReadOnly` — the store module that DEFINES isMapReadOnly is exempt (it
// has no speleoStore dependency by design; a cross-store composition happens at
// call sites, not in uiStore.ts itself). Empty otherwise: every other call site
// must compose the SpeleoDB term.
export const MAP_READ_ONLY_EXEMPT = new Set([
  'src/store/uiStore.ts',
]);

const SRC_PREFIX = 'src/';
const TEST_RE = /(^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$/;
const CLOSURE_ADJUSTED_RE = /===\s*['"]closureAdjusted['"]/;
const IS_MAP_READ_ONLY_RE = /\bisMapReadOnly\b/;
const SPELEO_READ_ONLY_RE = /\bspeleoReadOnly\b|\bselectSpeleoReadOnly\b/;

function gitTrackedTsFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--', 'src/*.ts', 'src/*.tsx', 'src/**/*.ts', 'src/**/*.tsx'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.toString('utf8').split('\0').filter(Boolean);
}

// Strip a trailing `//` line comment before matching, so a comment that merely
// MENTIONS the pattern (common in this file's own docs, or explanatory code
// comments) doesn't count as a real comparison.
function stripLineComment(line) {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

// Count of raw `=== 'closureAdjusted'` comparisons in the file's code (not
// inside line comments).
export function countClosureAdjustedComparisons(text) {
  let count = 0;
  for (const rawLine of text.split('\n')) {
    if (CLOSURE_ADJUSTED_RE.test(stripLineComment(rawLine))) count++;
  }
  return count;
}

export function usesIsMapReadOnly(text) {
  return IS_MAP_READ_ONLY_RE.test(text);
}

export function usesSpeleoReadOnly(text) {
  return SPELEO_READ_ONLY_RE.test(text);
}

function main() {
  let files;
  try {
    files = gitTrackedTsFiles();
  } catch (e) {
    console.error(`check-readonly-gates: could not list tracked files (run from a git repo): ${e.message}`);
    return 1;
  }

  const violationsA = [];
  const violationsB = [];

  for (const rel of files.sort()) {
    if (!rel.startsWith(SRC_PREFIX)) continue;
    if (TEST_RE.test(rel)) continue;
    const full = path.join(REPO_ROOT, rel);
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch (e) {
      console.error(`check-readonly-gates: could not read ${rel}: ${e.message}`);
      return 1;
    }

    const count = countClosureAdjustedComparisons(text);
    const allowed = CLOSURE_ADJUSTED_ALLOWLIST[rel] ?? 0;
    if (count > allowed) {
      violationsA.push(
        `${rel}: ${count} raw \`=== 'closureAdjusted'\` comparison(s) (allowlisted: ${allowed}). ` +
          `If this is a genuine mutation gate, compose isMapReadOnly(state) (+ speleoReadOnly) ` +
          `instead — see docs comment at the top of scripts/check-readonly-gates.mjs. If it is a ` +
          `reviewed display/coordinate-selection usage, add it to CLOSURE_ADJUSTED_ALLOWLIST there.`,
      );
    }

    if (usesIsMapReadOnly(text) && !usesSpeleoReadOnly(text) && !MAP_READ_ONLY_EXEMPT.has(rel)) {
      violationsB.push(
        `${rel}: uses isMapReadOnly without composing speleoReadOnly (selectSpeleoReadOnly) — a ` +
          `locked remote SpeleoDB project will look editable in the UI. Compose with ` +
          `\`useUIStore(isMapReadOnly) || useSpeleoStore(selectSpeleoReadOnly)\`, or add the file ` +
          `to MAP_READ_ONLY_EXEMPT with a written reason if it genuinely doesn't need it.`,
      );
    }
  }

  const violations = [...violationsA, ...violationsB];
  if (violations.length === 0) {
    console.log(`✓ readonly-gates: ${files.length} tracked TS/TSX files checked, no new raw closureAdjusted gates or missing speleoReadOnly composition.`);
    return 0;
  }

  console.error(`\n✗ readonly-gates check failed — ${violations.length} issue(s):\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error('');
  return 1;
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) process.exit(main());
