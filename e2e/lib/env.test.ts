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

/**
 * Expected config paths under `root`, spelled out as literal strings per
 * platform.
 *
 * Deliberately NOT rebuilt with `path.join` over the same branching env.ts uses:
 * a helper that mirrors the implementation lets a wrong-but-self-consistent shape
 * pass both. These literals pin the crate-derived shapes as data - the tauri
 * `app_config_dir` layout (`<config root>/<bundle identifier>`) and the
 * `directories` 5.0.1 `ProjectDirs::from("com", "stalagmight", "Stalagmight")`
 * layout - so a change to either shape must be made here on purpose.
 */
function expectedPaths(root: string): { appWritten: string; fallback: string } {
  if (process.platform === 'win32') {
    return {
      appWritten: `${root}\\com.stalagmight.desktop\\config.toml`,
      fallback: `${root}\\stalagmight\\Stalagmight\\config\\config.toml`,
    };
  }
  if (process.platform === 'darwin') {
    return {
      appWritten: `${root}/Library/Application Support/com.stalagmight.desktop/config.toml`,
      fallback: `${root}/Library/Application Support/com.stalagmight.Stalagmight/config.toml`,
    };
  }
  return {
    appWritten: `${root}/com.stalagmight.desktop/config.toml`,
    fallback: `${root}/stalagmight/config.toml`,
  };
}

/** Write a throwaway `tauri.conf.json` and run `body` against its path. */
function withTempConf(contents: string, body: (confPath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-env-conf-'));
  const confPath = path.join(dir, 'tauri.conf.json');
  fs.writeFileSync(confPath, contents);
  try {
    body(confPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  it('is actually parsed out of the given conf file, not a hardcoded constant', () => {
    // The load-bearing test for "not hardcoded": a conf carrying a DIFFERENT
    // identifier must come back verbatim. An implementation that returned
    // 'com.stalagmight.desktop' unconditionally would satisfy every assertion
    // that only compares against the repo's own manifest, but fails here.
    withTempConf(JSON.stringify({ identifier: 'org.example.other' }), (conf) => {
      expect(readBundleIdentifier(conf)).toBe('org.example.other');
    });
    withTempConf(JSON.stringify({ identifier: 'net.example.another-app' }), (conf) => {
      expect(readBundleIdentifier(conf)).toBe('net.example.another-app');
    });
  });

  it('reads src-tauri/tauri.conf.json in production', () => {
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
    withTempConf('{ not json', (bad) => {
      expect(() => readBundleIdentifier(bad)).toThrow(/not valid JSON/);
    });
  });

  it('throws loudly when the config has no identifier', () => {
    withTempConf(JSON.stringify({ productName: 'stalagmight' }), (bad) => {
      expect(() => readBundleIdentifier(bad)).toThrow(/no string "identifier" field/);
    });
  });

  // The identifier becomes a directory component of a config.toml this module
  // WRITES to, so a traversing or otherwise unusable value must be refused
  // rather than joined into a path.
  it.each(['../../evil', '..', '.', 'com/stalagmight', 'com\\stalagmight', 'com\0desktop'])(
    'rejects %j as a path component',
    (identifier) => {
      withTempConf(JSON.stringify({ identifier }), (bad) => {
        expect(() => readBundleIdentifier(bad)).toThrow(/unusable "identifier"/);
      });
    },
  );
});

describe('configTomlPath', () => {
  it('uses the Tauri bundle identifier as the config directory', () => {
    const p = configTomlPath(isolatedConfigEnv(path.join(os.tmpdir(), 'profile-root')));
    expect(path.basename(p)).toBe('config.toml');
    expect(path.basename(path.dirname(p))).toBe('com.stalagmight.desktop');
  });

  it('resolves the platform shape from the env override', () => {
    const root = path.join(os.tmpdir(), 'profile-root');
    expect(configTomlPath(isolatedConfigEnv(root))).toBe(expectedPaths(root).appWritten);
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
    expect(configTomlFallbackPath(isolatedConfigEnv(root))).toBe(expectedPaths(root).fallback);
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
