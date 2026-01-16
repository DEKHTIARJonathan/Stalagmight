import type { Options } from '@wdio/types';
import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';

let tauriDriver: ChildProcess | null = null;

// Detect platform and set appropriate binary path
const isWindows = process.platform === 'win32';
const binaryName = isWindows ? 'cavechef.exe' : 'cavechef';
const binaryPath = path.resolve(__dirname, `./src-tauri/target/debug/${binaryName}`);

export const config: Options.Testrunner = {
  // Test file pattern
  specs: ['./e2e/specs/**/*.spec.ts'],
  exclude: [],

  // Run tests sequentially (only one Tauri window at a time)
  maxInstances: 1,

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

  // Connection retry options
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  // Build the app before running tests
  onPrepare: function () {
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
