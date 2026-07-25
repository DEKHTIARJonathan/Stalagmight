/**
 * Build freshness + build for the agent harness. Mirrors the intent of
 * scripts/wdio.sh's freshness check: the debug binary must be newer than the
 * frontend/backend sources and must have been built with VITE_E2E=1 (the
 * window.__E2E_TEST__ hooks).
 *
 * mtimes alone cannot see *how* the binary was built, so a binary produced by
 * `./scripts/dev.sh` or a plain `pnpm tauri build` (no VITE_E2E) used to look
 * "fresh" and `build: "auto"` attached to a hookless dist, only to fail the
 * post-attach `__E2E_TEST__` check (issue #260). `buildApp` therefore drops an
 * E2E build stamp next to the binary recording that the build ran with
 * VITE_E2E=1, plus the mtime of the binary it produced. A missing stamp, a
 * stamp that disagrees with what this start is asking for, or a binary whose
 * mtime no longer matches the stamp (something rebuilt it behind our back) all
 * count as stale, so `auto` rebuilds *before* attach instead of failing after.
 *
 * The post-attach `__E2E_TEST__` check in session.ts stays as the definitive
 * backstop; this is the cheap pre-flight.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { binaryPath, cargoTargetDir } from '../../lib/env';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

/**
 * Stamp written by `buildApp` beside the binary it produced. Lives in the cargo
 * target dir (a build output, never the source tree, and outside the repo under
 * the default `~/.cargo_build`), so it is not something git can pick up.
 */
export interface E2EBuildStamp {
  /** Stamp schema version; an unknown version is treated as no stamp. */
  v: 1;
  /** Was the build run with VITE_E2E set (i.e. does dist carry the hooks)? */
  viteE2E: boolean;
  /** Vite mode the frontend leg was built in ('production' for `pnpm build`). */
  viteMode: string;
  /** mtime (ms) of the binary right after the build that wrote this stamp. */
  binaryMtimeMs: number;
  builtAtMs: number;
  builtAtIso: string;
}

/** Absolute path of the E2E build stamp for the current cargo target dir. */
export const buildStampPath = path.join(
  cargoTargetDir,
  'debug',
  '.stalagmight-e2e-build-stamp.json',
);

/** Read + validate the stamp. Returns null if missing, unreadable, or bogus. */
export function readBuildStamp(file: string = buildStampPath): E2EBuildStamp | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<E2EBuildStamp>;
  if (candidate.v !== 1) return null;
  if (typeof candidate.viteE2E !== 'boolean') return null;
  if (typeof candidate.binaryMtimeMs !== 'number') return null;
  return {
    v: 1,
    viteE2E: candidate.viteE2E,
    viteMode: typeof candidate.viteMode === 'string' ? candidate.viteMode : 'unknown',
    binaryMtimeMs: candidate.binaryMtimeMs,
    builtAtMs: typeof candidate.builtAtMs === 'number' ? candidate.builtAtMs : 0,
    builtAtIso: typeof candidate.builtAtIso === 'string' ? candidate.builtAtIso : '',
  };
}

/**
 * Pure staleness decision for the stamp half of the check. Returns the reasons
 * the current binary cannot be trusted to carry the requested VITE_E2E state;
 * an empty array means the stamp vouches for the binary.
 */
export function stampStaleReasons(
  stamp: E2EBuildStamp | null,
  want: { viteE2E: boolean; binaryMtimeMs: number },
): string[] {
  if (!stamp) {
    return ['no E2E build stamp: the binary was not built by this harness'];
  }
  const reasons: string[] = [];
  if (stamp.viteE2E !== want.viteE2E) {
    reasons.push(
      `build stamp says VITE_E2E=${stamp.viteE2E ? '1' : '0'} but this start needs ` +
        `VITE_E2E=${want.viteE2E ? '1' : '0'}`,
    );
  }
  if (stamp.binaryMtimeMs !== want.binaryMtimeMs) {
    reasons.push('the binary was rebuilt outside the harness since the E2E build stamp');
  }
  return reasons;
}

export interface Freshness {
  fresh: boolean;
  reasons: string[];
  binaryPath: string;
}

export interface FreshnessOptions {
  /** Does this start need the VITE_E2E frontend hooks? Defaults to true. */
  requireE2E?: boolean;
}

/**
 * Cheap heuristic: is the built binary newer than all tracked sources, and does
 * the E2E build stamp vouch for it carrying the requested VITE_E2E state?
 */
export function checkBuildFreshness(opts: FreshnessOptions = {}): Freshness {
  const requireE2E = opts.requireE2E ?? true;
  const reasons: string[] = [];
  const binMtime = mtimeOf(binaryPath);
  if (binMtime === 0) {
    return { fresh: false, reasons: [`binary missing at ${binaryPath}`], binaryPath };
  }

  reasons.push(
    ...stampStaleReasons(readBuildStamp(), { viteE2E: requireE2E, binaryMtimeMs: binMtime }),
  );

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
  // Build output goes to stderr (fd 2), NEVER inherited stdout: under the MCP
  // server, stdout is the JSON-RPC stream and any build chatter (pnpm/vite log
  // to stdout) would corrupt the protocol framing.
  execSync('pnpm tauri build --debug --no-bundle', {
    cwd: repoRoot,
    stdio: ['ignore', 2, 2],
    env: {
      ...process.env,
      VITE_E2E: '1',
      CARGO_TARGET_DIR: cargoTargetDir,
    },
  });
  writeBuildStamp({ viteE2E: true, viteMode: 'production' }, onLog);
  onLog?.('Build complete.');
}

/**
 * Record what the build we just ran produced, so the next `build: "auto"` can
 * tell a hookless binary from an E2E one without attaching first. Best-effort:
 * a stamp we fail to write just means the next start rebuilds.
 */
function writeBuildStamp(
  info: { viteE2E: boolean; viteMode: string },
  onLog?: (line: string) => void,
): void {
  const now = Date.now();
  const stamp: E2EBuildStamp = {
    v: 1,
    viteE2E: info.viteE2E,
    viteMode: info.viteMode,
    binaryMtimeMs: mtimeOf(binaryPath),
    builtAtMs: now,
    builtAtIso: new Date(now).toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(buildStampPath), { recursive: true });
    fs.writeFileSync(buildStampPath, `${JSON.stringify(stamp, null, 2)}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog?.(`Warning: could not write E2E build stamp (${msg}); next start will rebuild.`);
  }
}
