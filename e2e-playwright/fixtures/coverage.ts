import { test as base, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const coverageEnabled = process.env.E2E_COVERAGE === '1';
const defaultCoverageDir = path.resolve(process.cwd(), 'docs', 'coverage', 'raw', 'playwright');

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

export const test = base;
export { expect };
export * from '@playwright/test';

if (coverageEnabled) {
  test.afterEach(async ({ page }, testInfo) => {
    try {
      const coverage = await page.evaluate(() => {
        return (window as unknown as { __coverage__?: unknown }).__coverage__ ?? null;
      });
      if (!coverage) return;

      const coverageDir = process.env.COVERAGE_DIR || defaultCoverageDir;
      fs.mkdirSync(coverageDir, { recursive: true });

      const title = sanitizeFileName(testInfo.titlePath.join(' '));
      const fileBase = sanitizeFileName(path.basename(testInfo.file));
      const fileName = `${fileBase}-${title}-${testInfo.workerIndex}.json`;
      const filePath = path.join(coverageDir, fileName);
      fs.writeFileSync(filePath, JSON.stringify(coverage));
    } catch (error) {
      console.warn('Playwright coverage collection failed:', error);
    }
  });
}
