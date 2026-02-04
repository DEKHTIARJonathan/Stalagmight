import type { Options } from '@wdio/types';
import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let tauriDriver: ChildProcess | null = null;
let tempRoot: string | null = null;
let workerLogStream: fs.WriteStream | null = null;

// Directory for per-worker log files
const LOGS_DIR = path.join(__dirname, 'wdio-logs');

// Detect platform and set appropriate binary path
const isWindows = process.platform === 'win32';
const binaryName = isWindows ? 'stalagmight.exe' : 'stalagmight';
// Use CARGO_TARGET_DIR from tauri config (~/.cargo_build)
const cargoTargetDir = process.env.CARGO_TARGET_DIR || path.join(os.homedir(), '.cargo_build');
const binaryPath = path.join(cargoTargetDir, 'debug', binaryName);
const DEFAULT_MAX_INSTANCES = Math.max(1, Math.min(4, os.cpus().length));

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const maxInstances = readEnvInt('WDIO_MAX_INSTANCES', DEFAULT_MAX_INSTANCES);
const basePort = readEnvInt('WDIO_BASE_PORT', 4444);
const baseNativePort = readEnvInt('WDIO_BASE_NATIVE_PORT', basePort + 1000);

// Check if display is available (Linux only)
function checkDisplayAvailable(): boolean {
  if (isWindows) return true;

  // Check for DISPLAY environment variable
  if (process.env.DISPLAY) return true;

  // Check for Wayland
  if (process.env.WAYLAND_DISPLAY) return true;

  // Check if xvfb-run is available
  try {
    execSync('which xvfb-run', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Clear recent projects from config to ensure clean test state
function clearRecentProjects(): void {
  const configRoot = isWindows
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const configPath = path.join(configRoot, 'stalagmight', 'config.toml');

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

  // Retry failed specs once to handle parallel execution focus/timing issues
  specFileRetries: 1,

  // WebDriver capabilities for Tauri
  capabilities: [
    {
      'platformName': process.platform === 'win32' ? 'windows' : 'linux',
      'tauri:options': {
        application: binaryPath,
      },
    },
  ],

  // Connect to tauri-driver WebDriver server
  hostname: '127.0.0.1',
  port: 4444,

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
  onPrepare: function () {
    // Create/clear logs directory for this run
    if (fs.existsSync(LOGS_DIR)) {
      fs.rmSync(LOGS_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    console.log(`Worker logs will be written to: ${LOGS_DIR}`);

    // Fail fast if no display is available
    if (!checkDisplayAvailable()) {
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
      console.log('Building Tauri app in debug mode...');
      try {
        execSync('pnpm tauri build --debug --no-bundle', {
          stdio: 'inherit',
          cwd: process.cwd(),
          env: {
            ...process.env,
            VITE_E2E: '1',
          },
        });
        console.log('Build completed successfully');
      } catch (error) {
        console.error('Failed to build Tauri app:', error);
        throw error;
      }
    }
  },

  // Start tauri-driver before each test session
  beforeSession: function (wdioConfig, _capabilities, specs, cid) {
    const workerId = parseWorkerId(cid);
    const driverPort = basePort + workerId;
    const nativePort = baseNativePort + workerId;

    // Ensure each worker has isolated config/data/cache directories
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `stalagmight-wdio-${cid}-`));
    applyWorkerEnv(tempRoot);
    clearRecentProjects();

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

    console.log(`[${cid}] Starting tauri-driver on port ${driverPort}, logs: ${logPath}`);
    workerLogStream.write(`=== Worker ${cid} started at ${new Date().toISOString()} ===\n`);
    workerLogStream.write(`Spec: ${specs.join(', ')}\n`);
    workerLogStream.write(`Driver port: ${driverPort}, Native port: ${nativePort}\n\n`);

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

  // Log test results to per-spec log file
  afterTest: function (test, _context, { error, passed }) {
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
  },

  // Kill tauri-driver after tests complete
  afterSession: function () {
    if (workerLogStream) {
      workerLogStream.write(`\n=== Session ended at ${new Date().toISOString()} ===\n`);
      workerLogStream.end();
      workerLogStream = null;
    }

    if (tauriDriver) {
      tauriDriver.kill();
      tauriDriver = null;
    }

    if (tempRoot) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (error) {
        console.warn('Failed to remove temp directory:', error);
      }
      tempRoot = null;
    }
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
