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

/** Name of the built debug binary for this platform. */
export const binaryName = isWindows ? 'stalagmight.exe' : 'stalagmight';
/** Cargo target dir (matches tauri.conf.json's ~/.cargo_build default). */
export const cargoTargetDir =
  process.env.CARGO_TARGET_DIR || path.join(os.homedir(), '.cargo_build');
/** Absolute path to the built debug binary. */
export const binaryPath = path.join(cargoTargetDir, 'debug', binaryName);
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
 * Resolve the stalagmight config.toml path for a given environment map
 * (defaults to `process.env`). Used to target an isolated profile whose env was
 * NOT applied to `process.env`.
 */
export function configTomlPath(env: Record<string, string | undefined> = process.env): string {
  if (isWindows) {
    const configRoot = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(configRoot, 'stalagmight', 'config.toml');
  }
  if (isMacOS) {
    const home = env.HOME || os.homedir();
    return path.join(home, 'Library', 'Application Support', 'stalagmight', 'config.toml');
  }
  const configRoot = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configRoot, 'stalagmight', 'config.toml');
}

/**
 * Blank out `recent_projects` in the config to force clean test state. Reads
 * the config path from `env` (defaults to `process.env`) so the agent can
 * target its isolated profile. Best-effort: missing/unreadable config is a
 * no-op.
 */
export function clearRecentProjects(env: Record<string, string | undefined> = process.env): void {
  const configPath = configTomlPath(env);
  if (!fs.existsSync(configPath)) return;
  try {
    let content = fs.readFileSync(configPath, 'utf-8');
    content = content.replace(/recent_projects\s*=\s*\[[\s\S]*?\]/, 'recent_projects = []');
    fs.writeFileSync(configPath, content);
  } catch {
    // Best-effort: a locked/unreadable config just means no clearing happened.
  }
}
