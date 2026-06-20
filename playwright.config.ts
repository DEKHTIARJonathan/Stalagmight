import { defineConfig, devices } from '@playwright/test';

const coverageEnabled = process.env.E2E_COVERAGE === '1';
const devServerCommand = coverageEnabled ? 'VITE_COVERAGE=1 pnpm dev' : 'pnpm dev';

// Retries: CI gets 2; locally 1, so a single timing blip under load (e.g. the
// pre-push @smoke gate on a 1-worker headless VM) doesn't abort an otherwise-
// green push (issue #15). PW_RETRIES overrides, but only with a validated
// non-negative integer — anything else (PW_RETRIES=foo, -1, 1.5) falls back to
// the default instead of becoming NaN and breaking config load.
const defaultRetries = process.env.CI ? 2 : 1;
const envRetries = Number(process.env.PW_RETRIES);
const retries =
  process.env.PW_RETRIES !== undefined && Number.isInteger(envRetries) && envRetries >= 0
    ? envRetries
    : defaultRetries;

// Workers: PW_WORKERS overrides. Playwright's `workers` accepts a number OR a
// percentage string ("50%") but NOT a bare numeric *string*, which it rejects
// with "config.workers must be a number or percentage" (#132). Env vars are
// always strings, so coerce a bare integer (PW_WORKERS=3) to a Number while
// leaving a percentage ("50%") as-is. In CI default to "100%" (all cores):
// Playwright's own default is floor(cpus/2) = 1 worker (serial) on a 2-core
// runner (#120).
const envWorkers = process.env.PW_WORKERS;
const workers =
  envWorkers === undefined || envWorkers === ''
    ? process.env.CI
      ? '100%'
      : undefined
    : /^\d+$/.test(envWorkers)
      ? Number(envWorkers)
      : envWorkers;

/**
 * Playwright configuration for fast UI tests with Tauri IPC mocking.
 * These tests run against the Vite dev server with mocked Tauri commands.
 */
export default defineConfig({
  testDir: './e2e-playwright',

  // Run tests in parallel for speed
  fullyParallel: true,

  // Fail CI if test.only is committed
  forbidOnly: !!process.env.CI,

  // Derived above (validated PW_RETRIES override; CI 2 / local 1).
  retries,

  // Derived + validated above (PW_WORKERS: bare int -> number, "50%" kept as-is;
  // CI defaults to "100%" / all cores). See #120, #132.
  workers,

  // Test reporter: 'list' for live progress, 'github' for CI annotations
  // Override with PW_REPORTER env var (e.g. PW_REPORTER=html)
  reporter: process.env.PW_REPORTER || (process.env.CI ? 'github' : 'list'),

  // Shared settings for all projects
  use: {
    // Base URL for the Vite dev server
    baseURL: 'http://localhost:1420',
    locale: 'en-US',

    // Collect trace when retrying a failed test
    trace: 'on-first-retry',

    // Screenshots on failure
    screenshot: 'only-on-failure',

    // Video recording on failure
    video: 'retain-on-failure',
  },

  // Configure projects for cross-browser testing
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Add Firefox and WebKit if needed
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },
  ],

  // Run local dev server before starting tests
  webServer: {
    command: devServerCommand,
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI && !coverageEnabled,
    timeout: 120000, // 2 minutes to start dev server
  },

  // Test timeout
  timeout: 30000,

  // Expect timeout
  expect: {
    timeout: 5000,
  },

  // Output folder for test artifacts
  outputDir: 'test-results',
});
