/**
 * Build freshness + build for the agent harness. Mirrors the intent of
 * scripts/wdio.sh's freshness check: the debug binary must be newer than the
 * frontend/backend sources and must have been built with VITE_E2E=1 (the
 * window.__E2E_TEST__ hooks). The definitive VITE_E2E check happens post-attach
 * in session.ts (verify __E2E_TEST__ exists); this is the cheap pre-flight.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { binaryPath, cargoTargetDir } from '../../lib/env';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');

// Source inputs whose changes should invalidate the built binary.
const SOURCE_DIRS = ['src', path.join('src-tauri', 'src')];
const SOURCE_FILES = [
  path.join('src-tauri', 'tauri.conf.json'),
  'package.json',
  'index.html',
  'vite.config.ts',
];

/** Newest mtime (ms) among files under `dir`, recursively; 0 if missing. */
function newestMtimeInDir(dir: string): number {
  let newest = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtimeInDir(full));
    } else {
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        // Skip unreadable files.
      }
    }
  }
  return newest;
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export interface Freshness {
  fresh: boolean;
  reasons: string[];
  binaryPath: string;
}

/** Cheap heuristic: is the built binary newer than all tracked sources? */
export function checkBuildFreshness(): Freshness {
  const reasons: string[] = [];
  const binMtime = mtimeOf(binaryPath);
  if (binMtime === 0) {
    return { fresh: false, reasons: [`binary missing at ${binaryPath}`], binaryPath };
  }

  let newestSource = 0;
  for (const dir of SOURCE_DIRS) {
    newestSource = Math.max(newestSource, newestMtimeInDir(path.join(repoRoot, dir)));
  }
  for (const file of SOURCE_FILES) {
    newestSource = Math.max(newestSource, mtimeOf(path.join(repoRoot, file)));
  }
  if (newestSource > binMtime) {
    reasons.push('a source file is newer than the binary');
  }
  return { fresh: reasons.length === 0, reasons, binaryPath };
}

/**
 * Build the debug binary with the E2E frontend hooks. Blocking (this is a slow
 * one-time cost). Throws on build failure.
 */
export function buildApp(onLog?: (line: string) => void): void {
  onLog?.('Building Tauri debug app (VITE_E2E=1, --no-bundle)...');
  execSync('pnpm tauri build --debug --no-bundle', {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_E2E: '1',
      CARGO_TARGET_DIR: cargoTargetDir,
    },
  });
  onLog?.('Build complete.');
}
