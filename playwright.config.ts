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

  // Use PW_WORKERS env var to override (Playwright accepts either an
  // integer count or a percentage of logical CPU cores, e.g. "50%").
  // Pass the env var through as a string so percent values aren't
  // silently truncated by parseInt ("50%" → 50, which would launch
  // fifty workers instead of half the cores).
  //
  // In CI, default to "100%" (all cores). Playwright's default is
  // floor(cpus/2), which on a 2-core `ubuntu-latest` runner is **1 worker** —
  // i.e. the whole suite runs serially (this is why the nightly took ~57 min,
  // #120). Using both cores ~halves the nightly wall-clock with no coverage
  // change. The mocked-IPC suite is light enough that 2 Chromium workers fit
  // comfortably in the runner's RAM.
  workers: process.env.PW_WORKERS || (process.env.CI ? '100%' : undefined),

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
