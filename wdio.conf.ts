import type { Options } from '@wdio/types';
import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let tauriDriver: ChildProcess | null = null;

// Detect platform and set appropriate binary path
const isWindows = process.platform === 'win32';
const binaryName = isWindows ? 'cavechef.exe' : 'cavechef';
// Use CARGO_TARGET_DIR from tauri config (~/.cargo_build)
const cargoTargetDir = process.env.CARGO_TARGET_DIR || path.join(os.homedir(), '.cargo_build');
const binaryPath = path.join(cargoTargetDir, 'debug', binaryName);

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
  const configDir = path.join(os.homedir(), '.config', 'cavechef');
  const configPath = path.join(configDir, 'config.toml');

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

export const config: Options.Testrunner = {
  // Test file pattern
  specs: ['./e2e/specs/**/*.spec.ts'],
  exclude: [],

  // Run tests sequentially (only one Tauri window at a time)
  maxInstances: 1,

  // Run spec files sequentially to avoid resource contention
  specFileRetries: 0,

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

    // Clear recent projects to ensure tests start with a clean GlobalView
    clearRecentProjects();

    // Allow skipping build with SKIP_BUILD=1 for debugging
    if (process.env.SKIP_BUILD === '1') {
      console.log('Skipping build (SKIP_BUILD=1)');
    } else {
      console.log('Building Tauri app in debug mode...');
      try {
        execSync('pnpm tauri build --debug --no-bundle', {
          stdio: 'inherit',
          cwd: process.cwd(),
        });
        console.log('Build completed successfully');
      } catch (error) {
        console.error('Failed to build Tauri app:', error);
        throw error;
      }
    }
  },

  // Start tauri-driver before each test session
  beforeSession: function () {
    console.log('Starting tauri-driver...');
    tauriDriver = spawn('tauri-driver', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    tauriDriver.stdout?.on('data', (data) => {
      console.log(`tauri-driver: ${data}`);
    });

    tauriDriver.stderr?.on('data', (data) => {
      console.error(`tauri-driver error: ${data}`);
    });

    // Wait for driver to be ready
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        console.log('tauri-driver started');
        resolve();
      }, 2000);
    });
  },

  // Kill tauri-driver after tests complete
  afterSession: function () {
    if (tauriDriver) {
      console.log('Stopping tauri-driver...');
      tauriDriver.kill();
      tauriDriver = null;
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
