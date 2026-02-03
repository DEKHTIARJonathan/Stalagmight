import { defineConfig, devices } from '@playwright/test';

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

  // Retry failed tests in CI
  retries: process.env.CI ? 2 : 0,

  // Limit workers in CI to avoid resource contention
  workers: process.env.CI ? 1 : undefined,

  // Test reporter configuration
  reporter: process.env.CI ? 'github' : 'html',

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
    command: 'pnpm dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
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
