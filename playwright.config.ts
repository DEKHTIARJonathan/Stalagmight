import { defineConfig, devices } from '@playwright/test';

const coverageEnabled = process.env.E2E_COVERAGE === '1';
const devServerCommand = coverageEnabled ? 'VITE_COVERAGE=1 pnpm dev' : 'pnpm dev';

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

  // Retry flaky tests. CI gets 2; locally we still retry once so a single
  // timing blip under load — e.g. the pre-push @smoke gate on a 1-worker
  // headless VM — doesn't abort an otherwise-green push (issue #15).
  // Override with PW_RETRIES (e.g. PW_RETRIES=0 to fail fast during dev).
  retries:
    process.env.PW_RETRIES !== undefined
      ? Number(process.env.PW_RETRIES)
      : process.env.CI
        ? 2
        : 1,

  // Use PW_WORKERS env var to override (Playwright accepts either an
  // integer count or a percentage of logical CPU cores, e.g. "50%").
  // Pass the env var through as a string so percent values aren't
  // silently truncated by parseInt ("50%" → 50, which would launch
  // fifty workers instead of half the cores).
  workers: process.env.PW_WORKERS || undefined,

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
