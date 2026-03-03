import type { Options } from '@wdio/types';
import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let tauriDriver: ChildProcess | null = null;
let tauriWdShared: ChildProcess | null = null; // macOS: single shared tauri-wd started in onPrepare
let macTempRoot: string | null = null; // macOS: session-wide temp HOME (set in onPrepare, cleaned in onComplete)
let tempRoot: string | null = null;
let workerLogStream: fs.WriteStream | null = null;
let xvfbProcess: ChildProcess | null = null;
let currentWorkerId: number | null = null;

// Directory for per-worker log files
const LOGS_DIR = path.join(__dirname, 'wdio-logs');
const coverageEnabled = process.env.E2E_COVERAGE === '1';
const defaultCoverageDir = path.join(__dirname, 'docs', 'coverage', 'raw', 'wdio');

// Detect platform and set appropriate binary path
const isWindows = process.platform === 'win32';
const isMacOS = process.platform === 'darwin';
const binaryName = isWindows ? 'stalagmight.exe' : 'stalagmight';
// Use CARGO_TARGET_DIR from tauri config (~/.cargo_build)
const cargoTargetDir = process.env.CARGO_TARGET_DIR || path.join(os.homedir(), '.cargo_build');
const binaryPath = path.join(cargoTargetDir, 'debug', binaryName);
// macOS: use a wrapper that delays the [webdriver] port announcement by 500ms,
// giving the Tauri window time to be created before tauri-wd creates a session.
const macWrapperPath = path.join(__dirname, 'e2e', 'mac-app-wrapper.mjs');
const DEFAULT_MAX_INSTANCES = Math.max(1, Math.min(4, os.cpus().length));

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// macOS: force sequential execution — shared tauri-wd means all apps inherit
// the same environment, so parallel workers would contend on config/data files.
const maxInstances = isMacOS ? 1 : readEnvInt('WDIO_MAX_INSTANCES', DEFAULT_MAX_INSTANCES);
const basePort = readEnvInt('WDIO_BASE_PORT', 4444);
const baseNativePort = readEnvInt('WDIO_BASE_NATIVE_PORT', basePort + 1000);
const xvfbScreen = process.env.WDIO_XVFB_SCREEN || '1280x720x24';
const xvfbDisplays = [
  process.env.WDIO_XVFB_DISPLAY,
  ':99',
  ':98',
  ':97',
  ':96',
].filter((value): value is string => Boolean(value));

// Check if display is available (Linux only — macOS always has Quartz)
function checkDisplayAvailable(): boolean {
  if (isWindows) return true;
  if (isMacOS) return true;

  // Check for DISPLAY environment variable
  if (process.env.DISPLAY) return true;

  // Check for Wayland
  if (process.env.WAYLAND_DISPLAY) return true;

  return false;
}

async function startXvfb(): Promise<boolean> {
  if (isWindows) return true;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true;
  if (xvfbProcess) return true;

  try {
    execSync('which Xvfb', { stdio: 'ignore' });
  } catch {
    return false;
  }

  for (const display of xvfbDisplays) {
    const child = spawn('Xvfb', [display, '-screen', '0', xvfbScreen, '-ac', '-nolisten', 'tcp'], {
      stdio: 'ignore',
    });

    const started = await new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(child.exitCode === null);
        }
      }, 250);

      child.once('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      });

      child.once('exit', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
    });

    if (started) {
      xvfbProcess = child;
      process.env.DISPLAY = display;
      return true;
    }
  }

  return false;
}

// Clear recent projects from config to ensure clean test state
function clearRecentProjects(): void {
  let configPath: string;
  if (isWindows) {
    const configRoot = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    configPath = path.join(configRoot, 'stalagmight', 'config.toml');
  } else if (isMacOS) {
    // macOS `directories` crate uses ~/Library/Application Support/ (ignores XDG)
    const home = process.env.HOME || os.homedir();
    configPath = path.join(home, 'Library', 'Application Support', 'stalagmight', 'config.toml');
  } else {
    const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    configPath = path.join(configRoot, 'stalagmight', 'config.toml');
  }

  if (fs.existsSync(configPath)) {
    try {
      let content = fs.readFileSync(configPath, 'utf-8');
      // Replace recent_projects with empty array
      content = content.replace(/recent_projects\s*=\s*\[[\s\S]*?\]/, 'recent_projects = []');
      fs.writeFileSync(configPath, content);
      console.log('Cleared recent projects from config for clean test state');
    } catch (error) {
      console.warn('Failed to clear recent projects:', error);
    }
  }
}

function parseWorkerId(cid: string): number {
  const parts = cid.split('-').map((part) => Number.parseInt(part, 10));
  if (parts.length === 2 && parts.every((value) => Number.isFinite(value))) {
    const [capabilityIndex, instanceIndex] = parts;
    return capabilityIndex * maxInstances + instanceIndex;
  }
  const fallback = Number.parseInt(cid.replace(/\D/g, ''), 10);
  return Number.isFinite(fallback) ? fallback : 0;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function getCoverageDir(): string {
  return process.env.COVERAGE_DIR || defaultCoverageDir;
}

function getTestLabel(test: { title?: string; parent?: { title?: string } | string }): string {
  const parentTitle = typeof test.parent === 'string'
    ? test.parent
    : test.parent?.title || 'suite';
  const title = test.title || 'test';
  return `${parentTitle}-${title}`;
}

function applyWorkerEnv(root: string): void {
  if (isWindows) {
    const appData = path.join(root, 'appdata');
    const localAppData = path.join(root, 'localappdata');
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(appData, { recursive: true });
    fs.mkdirSync(localAppData, { recursive: true });
    fs.mkdirSync(tmp, { recursive: true });
    process.env.APPDATA = appData;
    process.env.LOCALAPPDATA = localAppData;
    process.env.TEMP = tmp;
    process.env.TMP = tmp;
  } else if (isMacOS) {
    // macOS `directories` crate ignores XDG — it reads ~/Library/Application Support/
    // Override HOME so each worker gets isolated config/data paths
    const home = path.join(root, 'home');
    const libAppSupport = path.join(home, 'Library', 'Application Support');
    const libCaches = path.join(home, 'Library', 'Caches');
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(libAppSupport, { recursive: true });
    fs.mkdirSync(libCaches, { recursive: true });
    fs.mkdirSync(tmp, { recursive: true });
    process.env.HOME = home;
    process.env.TMPDIR = tmp;
    process.env.TEMP = tmp;
    process.env.TMP = tmp;
  } else {
    const config = path.join(root, 'config');
    const data = path.join(root, 'data');
    const cache = path.join(root, 'cache');
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(config, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(cache, { recursive: true });
    fs.mkdirSync(tmp, { recursive: true });
    process.env.XDG_CONFIG_HOME = config;
    process.env.XDG_DATA_HOME = data;
    process.env.XDG_CACHE_HOME = cache;
    process.env.TMPDIR = tmp;
    process.env.TEMP = tmp;
    process.env.TMP = tmp;
  }
}

export const config: Options.Testrunner = {
  // Test file pattern
  specs: ['./e2e/specs/**/*.spec.ts'],
  exclude: [],

  // Run tests in parallel (override with WDIO_MAX_INSTANCES=1 if needed)
  maxInstances,

  // Disable built-in xvfb-run wrapper (we manage Xvfb manually)
  autoXvfb: false,

  // Retry failed specs once to handle parallel execution focus/timing issues
  specFileRetries: 1,

  // WebDriver capabilities for Tauri
  capabilities: [
    {
      'platformName': isWindows ? 'windows' : isMacOS ? 'mac' : 'linux',
      'tauri:options': {
        // macOS: use wrapper to delay port announcement (prevents "no window" race)
        application: isMacOS ? macWrapperPath : binaryPath,
      },
    },
  ],

  // Connect to tauri-driver / tauri-wd WebDriver server
  hostname: '127.0.0.1',
  port: basePort,

  // Test framework configuration
  framework: 'mocha',
  reporters: ['spec'],

  mochaOpts: {
    ui: 'bdd',
    timeout: 60000, // 60 second timeout for E2E tests
  },

  // Log level
  logLevel: 'warn',

  // Wait for element timeout
  waitforTimeout: 10000,

  // Connection retry options (reduced to fail fast)
  connectionRetryTimeout: 30000,
  connectionRetryCount: 1,

  // Build the app before running tests
  onPrepare: async function () {
    // Create/clear logs directory for this run
    if (fs.existsSync(LOGS_DIR)) {
      fs.rmSync(LOGS_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    console.log(`Worker logs will be written to: ${LOGS_DIR}`);

    // Ensure a display is available for the Tauri app
    const displayReady = checkDisplayAvailable() || (await startXvfb());
    if (!displayReady) {
      console.error('\n' + '='.repeat(70));
      console.error('ERROR: No display available for WebdriverIO E2E tests.');
      console.error('');
      console.error('These tests require a graphical environment. Options:');
      console.error('  1. Run on a machine with a display (X11/Wayland)');
      console.error('  2. Install xvfb: sudo apt install xvfb');
      console.error('  3. Use Playwright tests instead: pnpm test:ui');
      console.error('='.repeat(70) + '\n');
      process.exit(1);
    }

    console.log(
      `WebdriverIO parallel settings: maxInstances=${maxInstances} basePort=${basePort} baseNativePort=${baseNativePort}`
    );

    // Allow skipping build with SKIP_BUILD=1 for debugging
    if (process.env.SKIP_BUILD === '1') {
      console.log('Skipping build (SKIP_BUILD=1)');
    } else {
      const buildCmd = isMacOS
        ? 'pnpm tauri build --debug --no-bundle -- --features e2e'
        : 'pnpm tauri build --debug --no-bundle';
      console.log(`Building Tauri app in debug mode${isMacOS ? ' (with e2e feature)' : ''}...`);
      try {
        execSync(buildCmd, {
          stdio: 'inherit',
          cwd: process.cwd(),
          env: {
            ...process.env,
            VITE_E2E: '1',
            ...(coverageEnabled ? { VITE_COVERAGE: '1' } : {}),
            CARGO_TARGET_DIR: cargoTargetDir,
          },
        });
        console.log('Build completed successfully');
      } catch (error) {
        console.error('Failed to build Tauri app:', error);
        throw error;
      }
    }

    // macOS: start a single shared tauri-wd instance in onPrepare.
    // tauri-wd crashes with "Address already in use" when spawned from wdio
    // worker processes (likely due to fd inheritance from the wdio runner).
    // Starting it once here avoids the issue; tauri-wd handles multiple sessions.
    //
    // Environment isolation: tauri-wd inherits the main process env, and apps
    // launched by tauri-wd inherit tauri-wd's env. So we set up an isolated
    // HOME here BEFORE starting tauri-wd, ensuring all apps use a clean config.
    if (isMacOS) {
      // Create isolated HOME so the app doesn't read the user's real config
      macTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-wdio-shared-'));
      applyWorkerEnv(macTempRoot);
      console.log(`macOS env isolation: HOME=${process.env.HOME}`);

      // Set the real binary path for the wrapper script
      process.env.STALAGMIGHT_BINARY = binaryPath;
      console.log(`macOS wrapper: ${macWrapperPath} → ${binaryPath}`);

      console.log(`Starting shared tauri-wd on port ${basePort}...`);
      tauriWdShared = spawn('tauri-wd', ['--port', String(basePort)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      tauriWdShared.stdout?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.log(`[tauri-wd] ${msg}`);
      });
      tauriWdShared.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.error(`[tauri-wd] ${msg}`);
      });
      tauriWdShared.on('exit', (code: number | null) => {
        console.error(`[tauri-wd] exited with code ${code}`);
        tauriWdShared = null;
      });
      // Wait for tauri-wd to be ready
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      if (tauriWdShared?.exitCode !== null) {
        throw new Error('tauri-wd failed to start');
      }
      console.log('tauri-wd started successfully');
    }
  },

  // Start tauri-driver before each test session
  beforeSession: function (wdioConfig, _capabilities, specs, cid) {
    const workerId = parseWorkerId(cid);
    const driverPort = isMacOS ? basePort : basePort + workerId;
    const nativePort = baseNativePort + workerId;
    currentWorkerId = workerId;

    // macOS: env isolation was set up in onPrepare (before tauri-wd started),
    // so skip per-worker isolation — all sessions share the same tauri-wd env.
    if (!isMacOS) {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `stalagmight-wdio-${cid}-`));
      applyWorkerEnv(tempRoot);
      clearRecentProjects();
    }

    wdioConfig.port = driverPort;

    // Create per-worker log file
    const specName = specs.length > 0 ? path.basename(specs[0], '.spec.ts') : `worker-${cid}`;
    const logPath = path.join(LOGS_DIR, `${specName}.log`);
    workerLogStream = fs.createWriteStream(logPath, { flags: 'w' });

    const logToFile = (prefix: string, data: Buffer | string) => {
      const timestamp = new Date().toISOString();
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        workerLogStream?.write(`[${timestamp}] ${prefix}: ${line}\n`);
      }
    };

    // macOS: tauri-wd is already running (started in onPrepare), all workers share it
    if (isMacOS) {
      console.log(`[${cid}] Using shared tauri-wd on port ${driverPort}, logs: ${logPath}`);
      workerLogStream.write(`=== Worker ${cid} started at ${new Date().toISOString()} ===\n`);
      workerLogStream.write(`Spec: ${specs.join(', ')}\n`);
      workerLogStream.write(`Driver: tauri-wd (shared), port: ${driverPort}\n\n`);
      return;
    }

    // Linux/Windows: spawn a per-worker tauri-driver
    console.log(`[${cid}] Starting tauri-driver on port ${driverPort}, logs: ${logPath}`);
    workerLogStream.write(`=== Worker ${cid} started at ${new Date().toISOString()} ===\n`);
    workerLogStream.write(`Spec: ${specs.join(', ')}\n`);
    workerLogStream.write(`Driver: tauri-driver, port: ${driverPort}, native port: ${nativePort}\n\n`);

    tauriDriver = spawn('tauri-driver', ['--port', String(driverPort), '--native-port', String(nativePort)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
      },
    });

    tauriDriver.stdout?.on('data', (data) => {
      logToFile('stdout', data);
    });

    tauriDriver.stderr?.on('data', (data) => {
      logToFile('stderr', data);
    });

    // Wait for driver to be ready
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        workerLogStream?.write(`\n=== tauri-driver ready ===\n\n`);
        resolve();
      }, 2000);
    });
  },

  // macOS workarounds: override commands that pass element references to execute/sync.
  // tauri-plugin-webdriver-automation's __wdResolve re-queries DOM with
  // querySelectorAll(selector)[index], which returns undefined when React re-renders
  // shift element indices. These overrides pass CSS selectors as STRINGS instead.
  before: async function () {
    if (!isMacOS) return;

    // Helper: check if selector is a valid CSS selector (not XPath or WebdriverIO-specific)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isCssSelector = (el: any): boolean => {
      const sel = el?.selector;
      if (typeof sel !== 'string') return false;
      // Exclude XPath selectors
      if (sel.startsWith('//') || sel.startsWith('(')) return false;
      // Exclude WebdriverIO-specific selectors: tag=text, tag*=text, *=text, =text, aria/role
      if (/^[a-z]*\*?=/.test(sel) || sel.startsWith('aria/')) return false;
      return true;
    };

    // Override isDisplayed() — most common source of execute/sync element ref failures
    browser.overwriteCommand(
      'isDisplayed',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async function (this: any, _originalFn: () => Promise<boolean>) {
        try {
          if (isCssSelector(this)) {
            const result = await browser.execute(function (sel: string) {
              const el = document.querySelector(sel);
              if (!el) return false;
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              const rect = el.getBoundingClientRect();
              return rect.width > 0 || rect.height > 0;
            }, this.selector);
            return Boolean(result);
          }
          // For non-CSS selectors (button*=text, =text, etc.), use isExisting()
          // as best-effort check — can't use document.querySelector for these
          return await this.isExisting();
        } catch {
          return false;
        }
      },
      true,
    );

    // Override isClickable() — internally uses execute/sync for viewport/visibility checks
    browser.overwriteCommand(
      'isClickable',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async function (this: any, _originalFn: () => Promise<boolean>) {
        try {
          if (isCssSelector(this)) {
            const result = await browser.execute(function (sel: string) {
              const el = document.querySelector(sel);
              if (!el) return false;
              if ((el as HTMLButtonElement).disabled) return false;
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              if (style.pointerEvents === 'none') return false;
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) return false;
              return rect.top < window.innerHeight && rect.bottom > 0
                && rect.left < window.innerWidth && rect.right > 0;
            }, this.selector);
            return Boolean(result);
          }
          return await this.isExisting();
        } catch {
          return false;
        }
      },
      true,
    );

    // Override isSelected() — internally uses execute/sync for .checked/.selected
    browser.overwriteCommand(
      'isSelected',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async function (this: any, _originalFn: () => Promise<boolean>) {
        try {
          if (isCssSelector(this)) {
            const result = await browser.execute(function (sel: string) {
              const el = document.querySelector(sel) as HTMLInputElement | null;
              if (!el) return false;
              return el.checked ?? el.selected ?? el.getAttribute('aria-selected') === 'true';
            }, this.selector);
            return Boolean(result);
          }
          // Non-CSS selectors: use getAttribute as fallback
          const checked = await this.getAttribute('checked');
          const ariaSelected = await this.getAttribute('aria-selected');
          return checked !== null || ariaSelected === 'true';
        } catch {
          return false;
        }
      },
      true,
    );

    // Override browser.execute() to intercept WebdriverIO Element args.
    // When an Element object is passed, replace it with its CSS selector and
    // inject a preamble that resolves selectors to DOM nodes before the script runs.
    browser.overwriteCommand(
      'execute',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async function (originalFn: (...a: any[]) => Promise<any>, script: any, ...args: any[]) {
        // Only intercept if there are element reference args
        const hasElementArgs = args.some(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (a: any) => a && typeof a === 'object' && a.elementId && typeof a.selector === 'string',
        );
        if (!hasElementArgs) {
          return originalFn(script, ...args);
        }

        // Replace Element objects with { __wdio_sel: cssSelector } markers
        const patchedArgs = args.map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (a: any) => {
            if (a && typeof a === 'object' && a.elementId && typeof a.selector === 'string') {
              return { __wdio_sel: a.selector };
            }
            return a;
          },
        );

        // Wrap the script to resolve selector markers to DOM nodes
        const scriptStr = typeof script === 'function' ? script.toString() : String(script);
        const wrappedScript = `
          var __args = Array.prototype.slice.call(arguments);
          for (var i = 0; i < __args.length; i++) {
            if (__args[i] && __args[i].__wdio_sel) {
              __args[i] = document.querySelector(__args[i].__wdio_sel);
            }
          }
          return (${scriptStr}).apply(null, __args);
        `;
        return originalFn(wrappedScript, ...patchedArgs);
      },
    );
  },

  // Log test results to per-spec log file
  afterTest: async function (test, _context, { error, passed }) {
    if (workerLogStream) {
      const status = passed ? '✓ PASS' : '✗ FAIL';
      workerLogStream.write(`\n[TEST] ${status}: ${test.parent} > ${test.title}\n`);
      if (error) {
        workerLogStream.write(`  Error: ${error.message}\n`);
        if (error.stack) {
          workerLogStream.write(`  Stack: ${error.stack.split('\n').slice(0, 5).join('\n  ')}\n`);
        }
      }
    }

    if (!coverageEnabled) {
      return;
    }

    try {
      const coverage = await browser.execute(() => {
        return (window as unknown as { __coverage__?: unknown }).__coverage__ ?? null;
      });
      if (!coverage) return;

      const coverageDir = getCoverageDir();
      fs.mkdirSync(coverageDir, { recursive: true });

      const label = sanitizeFileName(getTestLabel(test));
      const workerSuffix = currentWorkerId ?? 0;
      const fileName = `${label}-${workerSuffix}-${Date.now()}.json`;
      const filePath = path.join(coverageDir, fileName);
      fs.writeFileSync(filePath, JSON.stringify(coverage));
    } catch (coverageError) {
      console.warn('WDIO coverage collection failed:', coverageError);
    }
  },

  // Kill tauri-driver after tests complete (Linux only; macOS uses shared instance)
  afterSession: function () {
    if (workerLogStream) {
      workerLogStream.write(`\n=== Session ended at ${new Date().toISOString()} ===\n`);
      workerLogStream.end();
      workerLogStream = null;
    }

    // On macOS, tauri-wd is shared and killed in onComplete
    if (tauriDriver && !isMacOS) {
      tauriDriver.kill();
      tauriDriver = null;
    }

    // On macOS, temp root is shared (macTempRoot) and cleaned in onComplete
    if (tempRoot && !isMacOS) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (error) {
        console.warn('Failed to remove temp directory:', error);
      }
      tempRoot = null;
    }

    currentWorkerId = null;
  },

  // Print summary of logs location after all tests complete
  onComplete: function (exitCode, _config, _capabilities, results) {
    console.log('\n' + '='.repeat(70));
    console.log(`Test run completed with exit code: ${exitCode}`);
    console.log(`\nPer-spec logs available in: ${LOGS_DIR}`);

    // List log files
    if (fs.existsSync(LOGS_DIR)) {
      const logFiles = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log'));
      if (logFiles.length > 0) {
        console.log('\nLog files:');
        for (const file of logFiles) {
          console.log(`  - ${file}`);
        }
      }
    }

    // If there were failures, suggest how to read logs
    if (results && results.failed > 0) {
      console.log(`\n⚠️  ${results.failed} spec(s) failed. Check the corresponding .log file for details.`);
    }
    console.log('='.repeat(70) + '\n');

    if (tauriWdShared) {
      tauriWdShared.kill();
      tauriWdShared = null;
    }

    if (macTempRoot) {
      try {
        fs.rmSync(macTempRoot, { recursive: true, force: true });
      } catch (error) {
        console.warn('Failed to remove macOS temp directory:', error);
      }
      macTempRoot = null;
    }

    if (xvfbProcess) {
      xvfbProcess.kill();
      xvfbProcess = null;
    }
  },

  // Auto-compile TypeScript
  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: {
      transpileOnly: true,
      project: './tsconfig.e2e.json',
    },
  },
};
