import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
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
