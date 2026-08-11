/**
 * Shared environment + path helpers for driving the real Tauri binary under
 * WebDriver. Used by both the quarantined wdio runner (wdio.conf.ts) and the
 * agent harness (e2e/agent). Keep this behavior-identical to what wdio.conf.ts
 * did inline before extraction.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// e2e/lib/env.ts -> repo root is two levels up.
const repoRoot = path.resolve(__dirname, '..', '..');

const isWindows = process.platform === 'win32';
const isMacOS = process.platform === 'darwin';

/** Name of the built binary for this platform. */
export const binaryName = isWindows ? 'stalagmight.exe' : 'stalagmight';
/** Cargo target dir (the ~/.cargo_build default scripts/wdio.sh + mac-build.sh export). */
export const cargoTargetDir =
  process.env.CARGO_TARGET_DIR || path.join(os.homedir(), '.cargo_build');

/** Cargo profile the agent harness drives. Doubles as the target subdirectory. */
export type AgentBuildMode = 'debug' | 'release';

/**
 * Which build the AGENT harness drives. Debug unless
 * `STALAGMIGHT_AGENT_RELEASE=1`, and deliberately opt-in: a debug build's
 * `debug_assert!`s and its `debug_assertions`-gated self-checks are themselves
 * oracles (see docs/agent-harness.md), so the default must keep them.
 *
 * Read at CALL time, never cached, so a runner can set the variable after its
 * own module graph has loaded (which is what `--release` on `agent:scenario`
 * does).
 */
export function agentBuildMode(): AgentBuildMode {
  return process.env.STALAGMIGHT_AGENT_RELEASE === '1' ? 'release' : 'debug';
}

/** Absolute path to the built binary for `mode`. */
export function binaryPathFor(mode: AgentBuildMode): string {
  return path.join(cargoTargetDir, mode, binaryName);
}

/**
 * Absolute path to the built DEBUG binary.
 *
 * Still a constant because the quarantined wdio runner imports it and has no
 * release mode. The agent harness calls `binaryPathFor(agentBuildMode())`.
 */
export const binaryPath = binaryPathFor('debug');
/**
 * macOS wrapper that delays the `[webdriver]` port announcement by 500ms so the
 * Tauri window exists before tauri-wd creates a session. Resolved against the
 * repo root (not this file's dir).
 */
export const macWrapperPath = path.join(repoRoot, 'e2e', 'mac-app-wrapper.mjs');

/**
 * Build the environment-variable map for an isolated app profile rooted at
 * `root`, creating the backing directories. Does NOT mutate `process.env`: the
 * caller decides whether to apply it to its own process (a wdio worker) or hand
 * it to a child `spawn()` (the agent's tauri-driver). This is the key
 * difference from `applyWorkerEnv` and the reason the two are split.
 */
export function isolatedEnv(root: string): Record<string, string> {
  if (isWindows) {
    const appData = path.join(root, 'appdata');
    const localAppData = path.join(root, 'localappdata');
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(appData, { recursive: true });
    fs.mkdirSync(localAppData, { recursive: true });
    fs.mkdirSync(tmp, { recursive: true });
    return { APPDATA: appData, LOCALAPPDATA: localAppData, TEMP: tmp, TMP: tmp };
  }
  if (isMacOS) {
    // macOS `directories` crate ignores XDG; it reads ~/Library/Application Support.
    // Override HOME so each profile gets isolated config/data paths.
    const home = path.join(root, 'home');
    const libAppSupport = path.join(home, 'Library', 'Application Support');
    const libCaches = path.join(home, 'Library', 'Caches');
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(libAppSupport, { recursive: true });
    fs.mkdirSync(libCaches, { recursive: true });
    fs.mkdirSync(tmp, { recursive: true });
    return { HOME: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  }
  const config = path.join(root, 'config');
  const data = path.join(root, 'data');
  const cache = path.join(root, 'cache');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  return {
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
  };
}

/**
 * Apply an isolated profile to the CURRENT process's environment. Thin wrapper
 * over `isolatedEnv` for the wdio worker path (behavior-identical to the old
 * inline `applyWorkerEnv`).
 */
export function applyWorkerEnv(root: string): void {
  const env = isolatedEnv(root);
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
}

/**
 * Read the Tauri bundle identifier out of a `tauri.conf.json`.
 *
 * Exported for testing; production callers want [`bundleIdentifier`]. Throws
 * rather than falling back to a hardcoded default: every path derived from the
 * identifier targets the REAL app's config, and a silently-wrong path is
 * exactly the failure mode this helper exists to prevent (a `clearRecentProjects`
 * that no-ops against a nonexistent file, leaving stale state in a reused profile).
 */
export function readBundleIdentifier(confPath: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(confPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Cannot read the Tauri config at ${confPath} to resolve the bundle identifier: ${String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Tauri config at ${confPath} is not valid JSON: ${String(err)}`);
  }
  const identifier =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { identifier?: unknown }).identifier
      : undefined;
  if (typeof identifier !== 'string' || identifier.length === 0) {
    throw new Error(`Tauri config at ${confPath} has no string "identifier" field`);
  }
  // The identifier becomes a directory component of a config.toml this module
  // later WRITES to, so refuse anything that could escape the profile root or
  // resolve somewhere unintended. A malformed manifest should fail loudly here
  // rather than silently rewrite a file outside the isolated profile.
  if (
    identifier.includes('/') ||
    identifier.includes('\\') ||
    identifier.includes('\0') ||
    identifier === '.' ||
    identifier === '..'
  ) {
    throw new Error(
      `Tauri config at ${confPath} has an unusable "identifier" (${JSON.stringify(identifier)}): ` +
        'it is used as a path component, so it must not contain path separators or NUL, ' +
        'nor be "." or ".."',
    );
  }
  return identifier;
}

/** Absolute path to the app's `tauri.conf.json` (the identifier's source of truth). */
export const tauriConfPath = path.join(repoRoot, 'src-tauri', 'tauri.conf.json');

let cachedBundleIdentifier: string | undefined;

/**
 * The app's Tauri bundle identifier (`com.stalagmight.desktop`), read from
 * `src-tauri/tauri.conf.json` and cached. Never hardcoded here: if the manifest
 * changes, the harness must follow it or it silently targets the wrong profile.
 */
export function bundleIdentifier(): string {
  cachedBundleIdentifier ??= readBundleIdentifier(tauriConfPath);
  return cachedBundleIdentifier;
}

/**
 * Resolve the stalagmight config.toml path for a given environment map
 * (defaults to `process.env`). Used to target an isolated profile whose env was
 * NOT applied to `process.env`.
 *
 * This mirrors where the RUNNING app writes its config: `AppState` resolves it
 * through `app_dirs::config_dir()`, which the app seeds from Tauri's
 * `PathResolver::app_config_dir()` (src-tauri/src/commands/event_sink.rs). In
 * tauri 2.9.5 that is `dirs::config_dir().join(<bundle identifier>)`
 * (tauri-2.9.5/src/path/desktop.rs:238-242), and `dirs` 6.0.0 resolves
 * `config_dir()` to:
 *   - Linux:   `$XDG_CONFIG_HOME` else `$HOME/.config`        (dirs-6.0.0/src/lin.rs:9)
 *   - macOS:   `$HOME/Library/Application Support`            (dirs-6.0.0/src/mac.rs:10)
 *   - Windows: the RoamingAppData known folder, i.e. `%APPDATA%` in practice
 *              (dirs-6.0.0/src/win.rs:8 -> `dirs_sys::known_folder_roaming_app_data`;
 *              note the crate asks the Win32 known-folder API, so it follows the
 *              real roaming dir rather than the `APPDATA` variable itself).
 *
 * Pre-setup code paths use a different fallback - see [`configTomlFallbackPath`].
 */
export function configTomlPath(env: Record<string, string | undefined> = process.env): string {
  const identifier = bundleIdentifier();
  if (isWindows) {
    // KNOWN LIMITATION (harness-side best effort). `dirs` asks the Win32
    // known-folder API for RoamingAppData, which does NOT consult the `APPDATA`
    // environment variable - so the temp-APPDATA isolation `isolatedEnv` sets up
    // does not redirect the REAL app's config on Windows, and the path computed
    // here can differ from the one the running app actually writes. Consequence:
    // `clearRecentProjects` can miss on Windows and leave stale recents behind.
    // Correct on Linux (XDG_CONFIG_HOME is honored end to end) and macOS (HOME is);
    // best effort here. Left as-is deliberately: keying off APPDATA is still the
    // closest approximation available without querying the known folder itself.
    const configRoot = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(configRoot, identifier, 'config.toml');
  }
  if (isMacOS) {
    const home = env.HOME || os.homedir();
    return path.join(home, 'Library', 'Application Support', identifier, 'config.toml');
  }
  const configRoot = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configRoot, identifier, 'config.toml');
}

/**
 * Resolve the PRE-SETUP config.toml path: the `directories`-crate fallback the
 * app uses when `app_dirs` has not been initialised yet
 * (`Config::config_path()` in src-tauri/crates/core/src/config/types.rs:1477-1480,
 * `directories::ProjectDirs::from("com", "stalagmight", "Stalagmight").config_dir()`).
 *
 * Shapes verified against `directories` 5.0.1 (the version in
 * src-tauri/Cargo.lock), whose `project_dirs_from(qualifier, org, app)` differs
 * per platform:
 *   - Linux:   the qualifier and organization are DISCARDED and the application
 *              name is lowercased with whitespace stripped, so the project path
 *              is `stalagmight`; `config_dir` is `$XDG_CONFIG_HOME` else
 *              `$HOME/.config` joined with it
 *              => `<$XDG_CONFIG_HOME|~/.config>/stalagmight`
 *              (directories-5.0.1/src/lin.rs:67,92-93)
 *   - macOS:   the three parts are joined into a reverse-DNS bundle id
 *              (`com.stalagmight.Stalagmight`) under Application Support
 *              => `~/Library/Application Support/com.stalagmight.Stalagmight`
 *              (directories-5.0.1/src/mac.rs:68,91-97)
 *   - Windows: the project path is `<organization>\<application>` under the
 *              RoamingAppData known folder, plus a literal `config` leaf
 *              => `%APPDATA%\stalagmight\Stalagmight\config`
 *              (directories-5.0.1/src/win.rs:69,75,98-99)
 * `Config::config_path()` then appends `config.toml`.
 */
export function configTomlFallbackPath(
  env: Record<string, string | undefined> = process.env,
): string {
  if (isWindows) {
    const configRoot = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(configRoot, 'stalagmight', 'Stalagmight', 'config', 'config.toml');
  }
  if (isMacOS) {
    const home = env.HOME || os.homedir();
    return path.join(
      home,
      'Library',
      'Application Support',
      'com.stalagmight.Stalagmight',
      'config.toml',
    );
  }
  const configRoot = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configRoot, 'stalagmight', 'config.toml');
}

/** Blank out `recent_projects` in one config file. Best-effort, no-op if absent. */
function clearRecentProjectsIn(configPath: string): void {
  if (!fs.existsSync(configPath)) return;
  try {
    let content = fs.readFileSync(configPath, 'utf-8');
    content = content.replace(/recent_projects\s*=\s*\[[\s\S]*?\]/, 'recent_projects = []');
    fs.writeFileSync(configPath, content);
  } catch {
    // Best-effort: a locked/unreadable config just means no clearing happened.
  }
}

/**
 * Blank out `recent_projects` in the config to force clean test state. Reads
 * the config paths from `env` (defaults to `process.env`) so the agent can
 * target its isolated profile.
 *
 * Best-effort per FILE: a missing or unreadable config.toml is a no-op. Not
 * best-effort about WHICH file, though - resolving the paths goes through
 * `bundleIdentifier`/`readBundleIdentifier`, which throws outside the per-file
 * try/catch if `src-tauri/tauri.conf.json` is missing, malformed, or carries an
 * unusable identifier. That fail-loud is intended: a broken harness checkout
 * must not degrade into silently clearing nothing.
 *
 * Clears BOTH config locations - the bundle-identifier path the running app
 * writes, and the `directories`-crate fallback a pre-setup code path can write -
 * because either one left behind in a reused profile resurrects stale recents.
 */
export function clearRecentProjects(env: Record<string, string | undefined> = process.env): void {
  for (const configPath of new Set([configTomlPath(env), configTomlFallbackPath(env)])) {
    clearRecentProjectsIn(configPath);
  }
}
