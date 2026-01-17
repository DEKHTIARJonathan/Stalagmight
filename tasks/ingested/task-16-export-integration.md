# Task 16: Export Integration Tests (WebdriverIO)

## Overview
| Field | Value |
|-------|-------|
| **Task ID** | task-16 |
| **Category** | WebdriverIO E2E Tests |
| **Target File** | `e2e/specs/export-integration.spec.ts` (new file) |
| **Tests** | 4 |
| **Priority** | P2 - Medium |
| **Dependencies** | task-12 (DMP integration) |

## Affected Files
- `e2e/specs/export-integration.spec.ts` - New test file

## Test Environment

These tests run against the **full Tauri application** with real backend:
```bash
CARGO_TARGET_DIR=./src-tauri/target xvfb-run -a pnpm test:e2e --spec e2e/specs/export-integration.spec.ts
```

## Test Specifications

---

### Test 16.1: `should export project as CSV`

**Purpose:** Verify complete CSV export workflow creates valid file.

**Test Code:**
```typescript
import { browser, expect } from '@wdio/globals';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('Export Integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cavechef-export-'));

    await browser.waitUntil(
      async () => (await $('body')).isDisplayed(),
      { timeout: 30000 }
    );
  });

  afterEach(async () => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should export project as CSV', async () => {
    await createProjectAndImport('CSV Export Test', 'test_v5.dmp');

    // Open export dialog
    await browser.keys(['Control', 'e']);
    const exportDialog = await $('[data-testid="export-dialog"], [role="dialog"]');
    await exportDialog.waitForDisplayed({ timeout: 5000 });

    // Select CSV format
    const csvOption = await $('[data-testid="format-csv"]');
    await csvOption.click();

    // Configure options (use defaults)
    // Click Export
    const exportBtn = await $('button*=Export');
    await exportBtn.click();

    // Handle save dialog
    const savePathInput = await $('input[type="text"]');
    const exportPath = path.join(tempDir, 'export-test.csv');

    if (await savePathInput.isDisplayed()) {
      await savePathInput.setValue(exportPath);
      await $('button*=Save').click();
    }

    // Wait for success
    await browser.waitUntil(
      async () => {
        const success = await $('[data-testid="export-success"]');
        return success.isDisplayed();
      },
      { timeout: 10000 }
    );

    // Verify file was created
    expect(fs.existsSync(exportPath)).toBe(true);

    // Verify CSV content
    const csvContent = fs.readFileSync(exportPath, 'utf-8');
    expect(csvContent.length).toBeGreaterThan(0);

    // Should have header row
    const lines = csvContent.split('\n');
    expect(lines.length).toBeGreaterThan(1);

    // Header should contain expected columns
    const header = lines[0].toLowerCase();
    expect(header).toMatch(/station|x|y|z|depth/);

    // Should have data rows
    expect(lines.length).toBeGreaterThan(2);
  });
});
```

**Assertions:**
- [ ] Export dialog opens
- [ ] CSV format selectable
- [ ] Export creates file
- [ ] CSV has headers
- [ ] CSV has data rows
- [ ] Data is valid

---

### Test 16.2: `should export project as JSON`

**Purpose:** Verify JSON export creates valid, parseable JSON file.

**Test Code:**
```typescript
it('should export project as JSON', async () => {
  await createProjectAndImport('JSON Export Test', 'test_v5.dmp');

  await browser.keys(['Control', 'e']);
  await $('[role="dialog"]').waitForDisplayed();

  // Select JSON format
  const jsonOption = await $('[data-testid="format-json"]');
  await jsonOption.click();

  // Export
  await $('button*=Export').click();

  const savePathInput = await $('input[type="text"]');
  const exportPath = path.join(tempDir, 'export-test.json');

  if (await savePathInput.isDisplayed()) {
    await savePathInput.setValue(exportPath);
    await $('button*=Save').click();
  }

  await browser.waitUntil(
    async () => (await $('[data-testid="export-success"]')).isDisplayed(),
    { timeout: 10000 }
  );

  // Verify file exists
  expect(fs.existsSync(exportPath)).toBe(true);

  // Verify JSON is valid
  const jsonContent = fs.readFileSync(exportPath, 'utf-8');
  let parsed: any;
  expect(() => {
    parsed = JSON.parse(jsonContent);
  }).not.toThrow();

  // Verify JSON structure
  expect(parsed).toHaveProperty('project');
  expect(parsed.project).toHaveProperty('name');
  expect(parsed.project.name).toBe('JSON Export Test');

  // Should have sections
  expect(parsed).toHaveProperty('sections');
  expect(Array.isArray(parsed.sections)).toBe(true);
  expect(parsed.sections.length).toBeGreaterThan(0);

  // Sections should have shots
  expect(parsed.sections[0]).toHaveProperty('shots');
  expect(parsed.sections[0].shots.length).toBeGreaterThan(0);
});
```

**Assertions:**
- [ ] JSON format exports
- [ ] File is valid JSON
- [ ] Project name included
- [ ] Sections array present
- [ ] Shots included

---

### Test 16.3: `should export map as PNG image`

**Purpose:** Verify image export creates valid PNG file.

**Test Code:**
```typescript
it('should export map as PNG image', async () => {
  await createProjectAndImport('Image Export Test', 'test_v5.dmp');

  // Fit view first
  await browser.keys(['Control', '0']);
  await browser.pause(500);

  await browser.keys(['Control', 'e']);
  await $('[role="dialog"]').waitForDisplayed();

  // Select image format
  const imageOption = await $('[data-testid="format-image"]');
  await imageOption.click();

  // Ensure PNG is selected (default)
  const formatSelect = await $('[data-testid="image-format"]');
  if (await formatSelect.isDisplayed()) {
    await formatSelect.selectByVisibleText('PNG');
  }

  // Set resolution
  const widthInput = await $('[data-testid="image-width"]');
  if (await widthInput.isDisplayed()) {
    await widthInput.clearValue();
    await widthInput.setValue('1920');
  }

  const heightInput = await $('[data-testid="image-height"]');
  if (await heightInput.isDisplayed()) {
    await heightInput.clearValue();
    await heightInput.setValue('1080');
  }

  // Export
  await $('button*=Export').click();

  const savePathInput = await $('input[type="text"]');
  const exportPath = path.join(tempDir, 'export-test.png');

  if (await savePathInput.isDisplayed()) {
    await savePathInput.setValue(exportPath);
    await $('button*=Save').click();
  }

  await browser.waitUntil(
    async () => (await $('[data-testid="export-success"]')).isDisplayed(),
    { timeout: 15000 } // Images may take longer
  );

  // Verify file exists
  expect(fs.existsSync(exportPath)).toBe(true);

  // Verify it's a valid PNG (check magic bytes)
  const buffer = fs.readFileSync(exportPath);
  expect(buffer.length).toBeGreaterThan(0);

  // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
  const pngMagic = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  expect(buffer.slice(0, 8).equals(pngMagic)).toBe(true);

  // File should be reasonably sized
  expect(buffer.length).toBeGreaterThan(1000); // At least 1KB
});
```

**Assertions:**
- [ ] Image format exports
- [ ] File is valid PNG
- [ ] Correct dimensions (if verifiable)
- [ ] Contains visual content

---

### Test 16.4: `should export with custom options`

**Purpose:** Verify export options affect output correctly.

**Test Code:**
```typescript
it('should export with custom options', async () => {
  await createProjectAndImport('Custom Export Test', 'test_v5.dmp');

  await browser.keys(['Control', 'e']);
  await $('[role="dialog"]').waitForDisplayed();

  // Select CSV
  await $('[data-testid="format-csv"]').click();

  // Change delimiter to semicolon
  const delimiterSelect = await $('[data-testid="csv-delimiter"]');
  if (await delimiterSelect.isDisplayed()) {
    await delimiterSelect.selectByVisibleText('Semicolon (;)');
  }

  // Uncheck headers
  const includeHeaders = await $('[data-testid="csv-include-header"]');
  if (await includeHeaders.isDisplayed()) {
    await includeHeaders.click(); // Toggle off
  }

  // Export
  await $('button*=Export').click();

  const savePathInput = await $('input[type="text"]');
  const exportPath = path.join(tempDir, 'custom-export.csv');

  if (await savePathInput.isDisplayed()) {
    await savePathInput.setValue(exportPath);
    await $('button*=Save').click();
  }

  await browser.waitUntil(
    async () => (await $('[data-testid="export-success"]')).isDisplayed(),
    { timeout: 10000 }
  );

  // Verify customizations
  const csvContent = fs.readFileSync(exportPath, 'utf-8');
  const lines = csvContent.split('\n').filter(l => l.trim());

  // Should use semicolons
  expect(csvContent).toContain(';');
  expect(csvContent).not.toContain(','); // No commas if using semicolon

  // First line should be data, not header (if headers disabled)
  // This depends on how the option works - verify based on implementation
});

it('should handle export cancellation', async () => {
  await createProjectAndImport('Cancel Export Test', 'test_v5.dmp');

  await browser.keys(['Control', 'e']);
  await $('[role="dialog"]').waitForDisplayed();

  await $('[data-testid="format-csv"]').click();

  // Cancel instead of export
  const cancelBtn = await $('button*=Cancel');
  await cancelBtn.click();

  // Dialog should close
  await browser.waitUntil(
    async () => !(await $('[role="dialog"]').isDisplayed()),
    { timeout: 3000 }
  );

  // No files should be created in temp dir
  const files = fs.readdirSync(tempDir);
  expect(files.length).toBe(0);
});
```

**Assertions:**
- [ ] Custom delimiter used
- [ ] Header option respected
- [ ] Cancellation works
- [ ] No file on cancel

---

## Test Helper Functions

```typescript
async function createTestProject(name: string) {
  const newProjectBtn = await $('button*=New Project');
  await newProjectBtn.click();
  await $('input[type="text"]').setValue(name);
  await $('button*=Create').click();
  await browser.waitUntil(
    async () => (await $('canvas')).isDisplayed(),
    { timeout: 10000 }
  );
}

async function importDmpFile(filename: string) {
  await browser.keys(['Control', 'i']);
  await $('[role="dialog"]').waitForDisplayed();
  await $('input[type="file"]').setValue(
    path.resolve(__dirname, '../fixtures', filename)
  );
  await browser.waitUntil(
    async () => (await $('[data-testid="shot-table"]')).isDisplayed(),
    { timeout: 5000 }
  );
  await $('button*=Import').click();
  await browser.waitUntil(
    async () => !(await $('[role="dialog"]').isDisplayed()),
    { timeout: 5000 }
  );
}

async function createProjectAndImport(name: string, dmpFile: string) {
  await createTestProject(name);
  await importDmpFile(dmpFile);
}
```

---

## Verification

```bash
CARGO_TARGET_DIR=./src-tauri/target xvfb-run -a pnpm test:e2e --spec e2e/specs/export-integration.spec.ts
```

## Definition of Done
- [ ] All 4 tests implemented
- [ ] Tests pass with real backend
- [ ] CSV export tested
- [ ] JSON export tested
- [ ] Image export tested
- [ ] Custom options tested
- [ ] Export files verified
