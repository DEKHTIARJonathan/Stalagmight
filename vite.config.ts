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
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: [
      '**/e2e/**',
      '**/e2e-playwright/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/src-tauri/**',
    ],
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
