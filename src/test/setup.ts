/**
 * Vitest global setup (issue #107 — component-test tier).
 *
 * Runs before each test file, in that file's resolved environment. The tiers
 * are split by file extension via `environmentMatchGlobs` in vite.config.ts:
 *   - `*.{test,spec}.tsx` → jsdom  (component tests: render real React components)
 *   - `*.{test,spec}.ts`  → node   (pure logic: the ~1.2k existing fast tests)
 *
 * jest-dom matchers are cheap and DOM-agnostic to register, so we extend
 * Vitest's `expect` unconditionally. The React unmount-between-tests cleanup is
 * loaded lazily behind a `document` guard, so the node-env logic tests never
 * pull in react-dom and stay free of any DOM cost.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

afterEach(async () => {
  // Only component tests render into a DOM. We run with globals:false, so
  // React Testing Library's built-in afterEach auto-cleanup does not
  // self-register — do it explicitly here.
  if (typeof document !== 'undefined') {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  }
});
