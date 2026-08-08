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
import { agentBuildMode, binaryPathFor, cargoTargetDir, type AgentBuildMode } from '../../lib/env';
import { isDarwinTarget } from './platform';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * macOS has no external WebDriver daemon; the app itself must embed
 * tauri-plugin-webdriver-automation (cargo feature `e2e`) for tauri-wd to
 * attach. On Linux/Windows the plugin is not needed (and not wanted: the
 * feature adds an HTTP server to the binary). Keyed on the shared
 * targetPlatform() so build and session decisions cannot diverge.
 */
export function needsE2eFeature(): boolean {
  return isDarwinTarget();
}

// Source inputs whose changes should invalidate the built binary.
const SOURCE_DIRS = ['src', path.join('src-tauri', 'src'), path.join('src-tauri', 'crates')];
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
  v: 2;
  /** Cargo profile this binary was built with. */
  mode: AgentBuildMode;
  /**
   * Every cargo feature the build passed, comma-joined and sorted ('' = none).
   *
   * Overlaps `e2eFeature` on purpose and does not replace it: that one answers
   * "does this binary carry the WebDriver plugin this PLATFORM needs", which
   * is a darwin question, while this one answers "was it built with what this
   * PROFILE asks for". A mac debug build and a linux release build both carry
   * `e2e`, for unrelated reasons, and a stamp has to say which.
   */
  features: string;
  /** Was the build run with VITE_E2E set (i.e. does dist carry the hooks)? */
  viteE2E: boolean;
  /**
   * Was the binary compiled with the `e2e` cargo feature (the in-app WebDriver
   * plugin tauri-wd needs on macOS)? mtimes cannot see this either: a
   * plugin-less mac binary would otherwise pass freshness and then hang at
   * session creation with no "[webdriver] listening" line ever printed.
   */
  e2eFeature: boolean;
  /** Vite mode the frontend leg was built in ('production' for `pnpm build`). */
  viteMode: string;
  /** mtime (ms) of the binary right after the build that wrote this stamp. */
  binaryMtimeMs: number;
  builtAtMs: number;
  builtAtIso: string;
}

/**
 * Absolute path of the E2E build stamp for `mode`.
 *
 * One stamp per profile, living beside the binary it vouches for, so switching
 * between debug and release neither thrashes rebuilds nor lets a stale binary
 * from the other profile look fresh.
 */
export function buildStampPathFor(mode: AgentBuildMode): string {
  return path.join(cargoTargetDir, mode, '.stalagmight-e2e-build-stamp.json');
}

/** Stamp path for the DEBUG build (the default profile). */
export const buildStampPath = buildStampPathFor('debug');

/**
 * Cargo features each profile is built with.
 *
 * Release adds `e2e`, which is the repo's own name for this build: it keeps the
 * BODY of `debug_trigger_panic` compiled in (`#[cfg(any(debug_assertions,
 * feature = "e2e"))]` is on the body blocks, not on the command - the command
 * itself stays registered in every build so the invoke-handler and
 * telemetry-registry contracts are build-invariant, see
 * src-tauri/src/commands/debug.rs), so the crash-oracle self-test still works
 * without `debug_assertions`. Debug gets that for free and so passes nothing,
 * which keeps the DEFAULT build byte-for-byte what it has always been.
 *
 * WHAT ELSE THE FEATURE BRINGS, and it is not nothing: `e2e` also enables
 * `tauri-plugin-webdriver-automation` (`src-tauri/Cargo.toml`), which
 * `src-tauri/src/lib.rs` registers under `#[cfg(feature = "e2e")]`. So a
 * release session drives an app with one more plugin than a debug session does,
 * and "release differs only by compiled-out debug_asserts" is not the whole
 * truth - a finding that reproduces in one mode and not the other has a second
 * candidate explanation. The WDIO tier passes `--features e2e` for its DEBUG
 * build too (`scripts/wdio.sh`); this map deliberately does not, to leave the
 * agent harness's default build unchanged, and the asymmetry is recorded here
 * rather than discovered later.
 */
export const FEATURES_FOR_MODE: Record<AgentBuildMode, string[]> = {
  debug: [],
  release: ['e2e'],
};

/**
 * Every cargo feature a build of `mode` passes, on THIS platform.
 *
 * Two independent reasons to pass `--features e2e` - the PROFILE asks for it
 * (`FEATURES_FOR_MODE`, so release keeps `debug_trigger_panic`'s body) and the
 * PLATFORM asks for it (`needsE2eFeature`, so darwin gets the in-app WebDriver
 * plugin) - unioned into one answer.
 *
 * `buildApp` and `checkBuildFreshness` MUST derive from this same function.
 * They did not: the build unioned both reasons and stamped the result, while
 * the check asked the platform alone, so on Linux a release stamp said
 * `e2eFeature: true` and the check wanted `false`. `fresh` was then false the
 * instant the build finished - every `--release` start rebuilt from scratch,
 * and a fuzz-matrix run put K concurrent release builds on one target dir.
 */
export function featuresFor(mode: AgentBuildMode): string[] {
  return [...new Set([...FEATURES_FOR_MODE[mode], ...(needsE2eFeature() ? ['e2e'] : [])])].sort();
}

function featureKey(mode: AgentBuildMode): string {
  return featuresFor(mode).join(',');
}

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
  // A v1 stamp predates BOTH the e2eFeature field and the release mode, so it
  // can say neither whether the binary carries the WebDriver plugin nor which
  // profile it is. Treated as no stamp: one rebuild per machine, once.
  if (candidate.v !== 2) return null;
  if (candidate.mode !== 'debug' && candidate.mode !== 'release') return null;
  if (typeof candidate.features !== 'string') return null;
  if (typeof candidate.viteE2E !== 'boolean') return null;
  if (typeof candidate.e2eFeature !== 'boolean') return null;
  if (typeof candidate.binaryMtimeMs !== 'number') return null;
  return {
    v: 2,
    mode: candidate.mode,
    features: candidate.features,
    viteE2E: candidate.viteE2E,
    e2eFeature: candidate.e2eFeature,
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
  want: {
    viteE2E: boolean;
    e2eFeature: boolean;
    binaryMtimeMs: number;
    mode?: AgentBuildMode;
    features?: string;
  },
): string[] {
  if (!stamp) {
    return ['no E2E build stamp: the binary was not built by this harness'];
  }
  const reasons: string[] = [];
  if (want.mode !== undefined && stamp.mode !== want.mode) {
    reasons.push(`build stamp is for the ${stamp.mode} profile but this start needs ${want.mode}`);
  }
  if (want.features !== undefined && stamp.features !== want.features) {
    reasons.push(
      `build stamp was built with features "${stamp.features || '(none)'}" but this start needs ` +
        `"${want.features || '(none)'}"`,
    );
  }
  if (stamp.viteE2E !== want.viteE2E) {
    reasons.push(
      `build stamp says VITE_E2E=${stamp.viteE2E ? '1' : '0'} but this start needs ` +
        `VITE_E2E=${want.viteE2E ? '1' : '0'}`,
    );
  }
  if (stamp.e2eFeature !== want.e2eFeature) {
    reasons.push(
      `build stamp says the e2e cargo feature was ${stamp.e2eFeature ? 'on' : 'off'} ` +
        `but this start needs it ${want.e2eFeature ? 'on' : 'off'} ` +
        `(the profile and the platform both ask - see featuresFor)`,
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
  /** Profile to check. Defaults to `agentBuildMode()`. */
  mode?: AgentBuildMode;
}

/**
 * Cheap heuristic: is the built binary newer than all tracked sources, and does
 * the E2E build stamp vouch for it carrying the requested VITE_E2E state?
 */
export function checkBuildFreshness(opts: FreshnessOptions = {}): Freshness {
  const requireE2E = opts.requireE2E ?? true;
  const mode = opts.mode ?? agentBuildMode();
  const binaryPath = binaryPathFor(mode);
  const reasons: string[] = [];
  const binMtime = mtimeOf(binaryPath);
  if (binMtime === 0) {
    return { fresh: false, reasons: [`${mode} binary missing at ${binaryPath}`], binaryPath };
  }

  reasons.push(
    ...stampStaleReasons(readBuildStamp(buildStampPathFor(mode)), {
      viteE2E: requireE2E,
      e2eFeature: featuresFor(mode).includes('e2e'),
      binaryMtimeMs: binMtime,
      mode,
      features: featureKey(mode),
    }),
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
// The feature build regenerates these TRACKED files with the WebDriver
// plugin's ACL entries; the repo keeps the plain-build shape.
const SCHEMA_PATHSPEC = 'src-tauri/gen/schemas';
// Every ACL entry the plugin adds carries its crate name, so a diff whose added
// lines all mention it is harness churn and nothing else.
const PLUGIN_ACL_MARKER = 'webdriver-automation';

/** True when the tracked generated schemas have no uncommitted changes. */
function schemasClean(): boolean {
  try {
    execSync(`git diff --quiet -- ${SCHEMA_PATHSPEC}`, { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function schemaDiff(): string {
  try {
    return execSync(`git diff -- ${SCHEMA_PATHSPEC}`, { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    return '';
  }
}

/**
 * Is this schema diff nothing but the WebDriver plugin's ACL churn? Every added
 * line must mention the plugin; a single unrelated addition makes it somebody's
 * real work, which tooling must never discard.
 *
 * Pure (takes the diff text) so the classification is unit-testable without a
 * dirty worktree.
 */
export function isPluginAclChurn(diff: string): boolean {
  const lines = diff.split('\n');
  // A removal is never plugin churn: the feature build only ADDS ACL entries.
  // Any removed line therefore means a human edited these files, and restoring
  // would silently discard that edit - the exact data loss this guard exists to
  // prevent. (Missing this was a review finding: classifying on additions alone
  // called "your deletion + our churn" pure churn.)
  if (lines.some((line) => line.startsWith('-') && !line.startsWith('---'))) return false;
  const added = lines
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1).trim())
    .filter((line) => line.length > 0);
  return added.length > 0 && added.every((line) => line.includes(PLUGIN_ACL_MARKER));
}

export function buildApp(onLog?: (line: string) => void, mode: AgentBuildMode = agentBuildMode()): void {
  // Two independent reasons to pass `--features e2e`, UNIONED rather than
  // either-or: the PROFILE asks for it (release keeps `debug_trigger_panic`'s
  // body compiled in - `FEATURES_FOR_MODE`), and the PLATFORM asks for it
  // (darwin needs the in-app WebDriver plugin - `needsE2eFeature`). A mac
  // release build needs it once, not twice.
  const features = featuresFor(mode);
  const withE2eFeature = features.includes('e2e');
  // `--debug` selects the dev profile; its absence selects release. The frontend
  // leg is identical either way - `beforeBuildCommand` runs `pnpm build`, and
  // VITE_E2E=1 is what makes it emit the `window.__E2E_TEST__` hooks (the gate in
  // src/main.tsx is DEV || MODE==='test' || VITE_E2E==='1', so it works in a
  // production-mode vite build too).
  const profileFlag = mode === 'debug' ? ' --debug' : '';
  // The cargo-PASSTHROUGH form, which is what the WDIO tier uses and what has
  // been exercised on both platforms.
  const featureFlag = features.length > 0 ? ` -- --features ${features.join(',')}` : '';
  const command = `pnpm tauri build${profileFlag} --no-bundle${featureFlag}`;
  // Restore only churn that is provably the plugin's. Timing alone is not
  // enough: an interrupted feature build (a killed smoke, ctrl-c) leaves churn
  // behind, and a "was it clean before?" rule would then refuse to clean up
  // forever after. Classifying the DIFF instead recovers from that while still
  // never discarding a real edit to these files.
  const preBuildDirtIsOurs = withE2eFeature && (schemasClean() || isPluginAclChurn(schemaDiff()));
  onLog?.(
    `Building Tauri ${mode} app (VITE_E2E=1, --no-bundle${withE2eFeature ? ', --features e2e' : ''})...`,
  );
  // Build output goes to stderr (fd 2), NEVER inherited stdout: under the MCP
  // server, stdout is the JSON-RPC stream and any build chatter (pnpm/vite log
  // to stdout) would corrupt the protocol framing.
  execSync(command, {
    cwd: repoRoot,
    stdio: ['ignore', 2, 2],
    env: {
      ...process.env,
      VITE_E2E: '1',
      CARGO_TARGET_DIR: cargoTargetDir,
    },
  });
  if (withE2eFeature && !schemasClean()) {
    if (preBuildDirtIsOurs && isPluginAclChurn(schemaDiff())) {
      try {
        execSync(`git checkout -- ${SCHEMA_PATHSPEC}`, { cwd: repoRoot, stdio: 'ignore' });
        onLog?.(`Restored ${SCHEMA_PATHSPEC} (the e2e-feature build regenerates them with plugin ACL entries).`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onLog?.(`Warning: could not restore ${SCHEMA_PATHSPEC} (${msg}); do NOT commit them in this shape.`);
      }
    } else {
      onLog?.(
        `Warning: ${SCHEMA_PATHSPEC} carries changes beyond the plugin's ACL entries, so the ` +
          `harness left it alone rather than discarding real work - it now ALSO carries ` +
          `e2e-feature churn. Do not commit the plugin entries.`,
      );
    }
  }
  writeBuildStamp(
    { viteE2E: true, e2eFeature: withE2eFeature, viteMode: 'production', mode, features: features.join(',') },
    onLog,
  );
  onLog?.(`Build complete (${mode}).`);
}

/**
 * Record what the build we just ran produced, so the next `build: "auto"` can
 * tell a hookless binary from an E2E one without attaching first. Best-effort:
 * a stamp we fail to write just means the next start rebuilds.
 */
function writeBuildStamp(
  info: {
    viteE2E: boolean;
    e2eFeature: boolean;
    viteMode: string;
    mode: AgentBuildMode;
    features: string;
  },
  onLog?: (line: string) => void,
): void {
  const now = Date.now();
  const stampPath = buildStampPathFor(info.mode);
  const stamp: E2EBuildStamp = {
    v: 2,
    mode: info.mode,
    features: info.features,
    viteE2E: info.viteE2E,
    e2eFeature: info.e2eFeature,
    viteMode: info.viteMode,
    binaryMtimeMs: mtimeOf(binaryPathFor(info.mode)),
    builtAtMs: now,
    builtAtIso: new Date(now).toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog?.(`Warning: could not write E2E build stamp (${msg}); next start will rebuild.`);
  }
}
