/**
 * Unit tests for the harness config-path helpers (issue #319): `configTomlPath`
 * used to build `<config-root>/stalagmight/config.toml`, which is NOT where the
 * running app writes - the app uses Tauri's app_config_dir,
 * `<config-root>/<bundle identifier>/config.toml`. `clearRecentProjects()`
 * therefore no-opped against a nonexistent file and reused profiles kept their
 * stale recent-projects list.
 *
 * `isWindows`/`isMacOS` in env.ts are module-level constants derived from
 * `process.platform`, so the shape assertions below are written for whichever
 * platform the suite runs on; the env-override parameter is what makes them
 * hermetic (no real `~/.config` is read or written).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bundleIdentifier,
  clearRecentProjects,
  configTomlFallbackPath,
  configTomlPath,
  readBundleIdentifier,
  tauriConfPath,
} from './env';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

/**
 * Env map that redirects BOTH config locations under `root` on this platform:
 * Linux keys off XDG_CONFIG_HOME, macOS off HOME, Windows off APPDATA.
 */
function isolatedConfigEnv(root: string): Record<string, string> {
  if (process.platform === 'win32') return { APPDATA: root };
  if (process.platform === 'darwin') return { HOME: root };
  return { XDG_CONFIG_HOME: root };
}

/** Expected app-written config path under `root` for this platform. */
function expectedIdentifierPath(root: string, identifier: string): string {
  if (process.platform === 'darwin') {
    return path.join(root, 'Library', 'Application Support', identifier, 'config.toml');
  }
  // Linux: $XDG_CONFIG_HOME/<id>; Windows: %APPDATA%\<id>
  return path.join(root, identifier, 'config.toml');
}

/** Expected `directories`-crate fallback path under `root` for this platform. */
function expectedFallbackPath(root: string): string {
  if (process.platform === 'win32') {
    return path.join(root, 'stalagmight', 'Stalagmight', 'config', 'config.toml');
  }
  if (process.platform === 'darwin') {
    return path.join(
      root,
      'Library',
      'Application Support',
      'com.stalagmight.Stalagmight',
      'config.toml',
    );
  }
  return path.join(root, 'stalagmight', 'config.toml');
}

const CONFIG_WITH_RECENTS = [
  '[general]',
  'recent_projects = [',
  '  "/home/someone/a.stalx",',
  '  "/home/someone/b.stalx",',
  ']',
  'units = "metric"',
  '',
].join('\n');

describe('bundle identifier', () => {
  it('comes from src-tauri/tauri.conf.json, not a hardcoded constant', () => {
    const conf = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf-8'),
    ) as { identifier: string };
    expect(tauriConfPath).toBe(path.join(repoRoot, 'src-tauri', 'tauri.conf.json'));
    expect(bundleIdentifier()).toBe(conf.identifier);
    // Guards the fix itself: the app's current identifier.
    expect(bundleIdentifier()).toBe('com.stalagmight.desktop');
  });

  it('throws loudly when the config is unreadable', () => {
    const missing = path.join(os.tmpdir(), 'stalagmight-no-such-conf.json');
    expect(() => readBundleIdentifier(missing)).toThrow(/Cannot read the Tauri config/);
  });

  it('throws loudly when the config is not JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-env-conf-'));
    const bad = path.join(dir, 'tauri.conf.json');
    fs.writeFileSync(bad, '{ not json');
    try {
      expect(() => readBundleIdentifier(bad)).toThrow(/not valid JSON/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws loudly when the config has no identifier', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-env-conf-'));
    const bad = path.join(dir, 'tauri.conf.json');
    fs.writeFileSync(bad, JSON.stringify({ productName: 'stalagmight' }));
    try {
      expect(() => readBundleIdentifier(bad)).toThrow(/no string "identifier" field/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('configTomlPath', () => {
  it('uses the Tauri bundle identifier as the config directory', () => {
    const p = configTomlPath(isolatedConfigEnv(path.join(os.tmpdir(), 'profile-root')));
    expect(path.basename(p)).toBe('config.toml');
    expect(path.basename(path.dirname(p))).toBe('com.stalagmight.desktop');
  });

  it('resolves the platform shape from the env override', () => {
    const root = path.join(os.tmpdir(), 'profile-root');
    expect(configTomlPath(isolatedConfigEnv(root))).toBe(
      expectedIdentifierPath(root, 'com.stalagmight.desktop'),
    );
  });

  it('falls back to the home directory when the env override is absent', () => {
    const p = configTomlPath({});
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.startsWith(os.homedir())).toBe(true);
    expect(p).toContain('com.stalagmight.desktop');
  });
});

describe('configTomlFallbackPath', () => {
  it('matches the directories-crate ProjectDirs shape for this platform', () => {
    const root = path.join(os.tmpdir(), 'profile-root');
    expect(configTomlFallbackPath(isolatedConfigEnv(root))).toBe(expectedFallbackPath(root));
  });

  it('is a different location than the app-written config path', () => {
    const root = path.join(os.tmpdir(), 'profile-root');
    const env = isolatedConfigEnv(root);
    expect(configTomlFallbackPath(env)).not.toBe(configTomlPath(env));
  });
});

describe('clearRecentProjects', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-env-profile-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(p: string): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, CONFIG_WITH_RECENTS);
  }

  it('clears the bundle-identifier config the running app writes', () => {
    const env = isolatedConfigEnv(root);
    const appPath = configTomlPath(env);
    write(appPath);

    clearRecentProjects(env);

    const cleared = fs.readFileSync(appPath, 'utf-8');
    expect(cleared).toContain('recent_projects = []');
    expect(cleared).not.toContain('a.stalx');
    // Untouched keys survive: this is a targeted edit, not a rewrite.
    expect(cleared).toContain('units = "metric"');
  });

  it('clears the directories-crate fallback config too', () => {
    const env = isolatedConfigEnv(root);
    const fallback = configTomlFallbackPath(env);
    write(fallback);

    clearRecentProjects(env);

    expect(fs.readFileSync(fallback, 'utf-8')).toContain('recent_projects = []');
  });

  it('clears both locations in one call', () => {
    const env = isolatedConfigEnv(root);
    const appPath = configTomlPath(env);
    const fallback = configTomlFallbackPath(env);
    write(appPath);
    write(fallback);

    clearRecentProjects(env);

    expect(fs.readFileSync(appPath, 'utf-8')).not.toContain('b.stalx');
    expect(fs.readFileSync(fallback, 'utf-8')).not.toContain('b.stalx');
  });

  it('is a no-op when neither config exists', () => {
    const env = isolatedConfigEnv(root);
    expect(() => clearRecentProjects(env)).not.toThrow();
    expect(fs.existsSync(configTomlPath(env))).toBe(false);
    expect(fs.existsSync(configTomlFallbackPath(env))).toBe(false);
  });
});
