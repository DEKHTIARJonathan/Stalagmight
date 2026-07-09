import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import istanbul from 'vite-plugin-istanbul';
import { execSync } from 'node:child_process';
import pkg from './package.json';

/** Short hash of the checked-out commit, or `unknown` when git is unavailable. */
function gitShortHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

// Embed the exact commit in the displayed version: `x.y.z-<shorthash>` for CI
// builds and `x.y.z-dev-<shorthash>` for local builds (CI env var not set). Mirrors
// src-tauri/build.rs so the UI's About version and telemetry's app_version agree.
const shortHash = gitShortHash();
const appVersion = process.env.CI
  ? `${pkg.version}-${shortHash}`
  : `${pkg.version}-dev-${shortHash}`;

const coverageEnabled = process.env.VITE_COVERAGE === '1';
const plugins: PluginOption[] = [
  react(),
  coverageEnabled
    ? istanbul({
        include: 'src/**/*',
        exclude: [
          '**/*.d.ts',
          '**/*.{test,spec}.?(c|m)[jt]s?(x)',
          '**/__tests__/**',
          '**/e2e/**',
          '**/e2e-playwright/**',
          '**/node_modules/**',
          '**/dist/**',
          '**/src-tauri/**',
          'src/types/ipc/**',
          'src/types/ipc.generated.ts',
        ],
        extension: ['.ts', '.tsx'],
        forceBuildInstrument: true,
        requireEnv: false,
      })
    : undefined,
].filter(Boolean) as PluginOption[];

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  // Force a single React instance. The toolchain pins Node 22 (.nvmrc); on a
  // newer Node major, Vite's dep optimizer can intermittently pre-bundle two
  // copies of React, which surfaces as "Invalid hook call" + a blank window.
  // dedupe makes every `react`/`react-dom` import resolve to one copy, and the
  // explicit optimizeDeps entry keeps them pre-bundled together.
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom'],
  },
  plugins,
  clearScreen: false,
  build: coverageEnabled ? { sourcemap: true } : undefined,
  server: {
    port: 1420,
    strictPort: true,

    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  test: {
    // scripts/**/*.test.ts: golden tests for the repo's Node tooling (e.g. the
    // agent replay/repro generators) so a parser regression there fails
    // `pnpm test`. Deliberately .ts-only: the standalone *.test.mjs files in
    // scripts/ are plain node self-test scripts (run via lint:*:test), not
    // vitest suites.
    include: [
      'src/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'scripts/**/*.{test,spec}.ts',
    ],
    exclude: [
      '**/e2e/**',
      '**/e2e-playwright/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/src-tauri/**',
    ],
    // Tiered by extension (issue #107): pure-logic tests stay in `node` (fast,
    // no DOM cost); component tests (`*.{test,spec}.tsx`) get a jsdom DOM so
    // real React components can be rendered with Testing Library.
    environment: 'node',
    environmentMatchGlobs: [['**/*.{test,spec}.tsx', 'jsdom']],
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      all: true,
      reportsDirectory: 'docs/coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.d.ts',
        '**/*.{test,spec}.?(c|m)[jt]s?(x)',
        '**/__tests__/**',
        '**/e2e/**',
        '**/e2e-playwright/**',
        '**/node_modules/**',
        '**/dist/**',
        '**/src-tauri/**',
        '**/coverage/**',
        'src/types/ipc/**',
        'src/types/ipc.generated.ts',
      ],
      reporter: ['text', 'html', 'json', 'lcov'],
    },
  },
});
