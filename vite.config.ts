import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import istanbul from 'vite-plugin-istanbul';
import pkg from './package.json';

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
    __APP_VERSION__: JSON.stringify(pkg.version),
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
