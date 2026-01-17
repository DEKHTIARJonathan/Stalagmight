# Task 12: DMP Integration Tests (WebdriverIO)

## Overview
| Field | Value |
|-------|-------|
| **Task ID** | task-12 |
| **Category** | WebdriverIO E2E Tests |
| **Target File** | `e2e/specs/dmp-integration.spec.ts` (new file) |
| **Tests** | 6 |
| **Priority** | P0 - Critical |
| **Dependencies** | None (uses real backend) |

## Affected Files
- `e2e/specs/dmp-integration.spec.ts` - New test file
- `e2e/fixtures/` - Test DMP files

## Test Environment

These tests run against the **full Tauri application** with real backend:
- Uses WebdriverIO + tauri-driver
- Linux/Windows only (macOS not supported)
- Requires `xvfb-run` for headless CI

```bash
# Run tests
CARGO_TARGET_DIR=./src-tauri/target xvfb-run -a pnpm test:e2e --spec e2e/specs/dmp-integration.spec.ts
```

## Test Specifications

---

### Test 12.1: `should import DMP v2 file successfully`

**Purpose:** Verify complete workflow of importing a version 2 DMP file.

**Test Code:**
```typescript
import { browser, expect } from '@wdio/globals';
import * as path from 'path';

describe('DMP Integration', () => {
  beforeEach(async () => {
    // Wait for app to load
    await browser.waitUntil(
      async () => {
        const body = await $('body');
        return body.isDisplayed();
      },
      { timeout: 30000, timeoutMsg: 'App did not load in time' }
    );
  });

  it('should import DMP v2 file successfully', async () => {
    // Create new project first
    const newProjectBtn = await $('button*=New Project');
    await newProjectBtn.click();

    // Fill project name
    const nameInput = await $('[data-testid="project-name-input"], input[type="text"]');
    await nameInput.setValue('DMP v2 Test');

    const createBtn = await $('button*=Create');
    await createBtn.click();

    // Wait for project view
    await browser.waitUntil(
      async () => (await $('canvas')).isDisplayed(),
      { timeout: 10000 }
    );

    // Open import dialog (Ctrl+I)
    await browser.keys(['Control', 'i']);

    // Wait for import dialog
    const importDialog = await $('[data-testid="import-dmp-dialog"], [role="dialog"]');
    await importDialog.waitForDisplayed({ timeout: 5000 });

    // Upload DMP v2 file
    const fileInput = await $('input[type="file"]');
    const fixturesPath = path.resolve(__dirname, '../fixtures/test_v2.dmp');
    await fileInput.setValue(fixturesPath);

    // Wait for parsing
    await browser.waitUntil(
      async () => {
        const shotTable = await $('[data-testid="shot-table"]');
        return shotTable.isDisplayed();
      },
      { timeout: 5000, timeoutMsg: 'DMP file did not parse' }
    );

    // Verify shots displayed
    const shotRows = await $$('[data-testid="shot-table"] tbody tr');
    expect(shotRows.length).toBeGreaterThan(0);

    // Click Import button
    const importBtn = await $('button*=Import');
    await importBtn.click();

    // Wait for dialog to close
    await browser.waitUntil(
      async () => !(await importDialog.isDisplayed()),
      { timeout: 5000 }
    );

    // Verify section appears in sections panel
    const sectionHeader = await $('[data-testid="section-header"]');
    await sectionHeader.waitForDisplayed();

    // Verify map shows survey
    const canvas = await $('canvas');
    expect(await canvas.isDisplayed()).toBe(true);
  });
});
```

**Assertions:**
- [ ] Project created
- [ ] Import dialog opens
- [ ] DMP v2 file parses
- [ ] Shots displayed in table
- [ ] Import creates section
- [ ] Section visible in panel
- [ ] Survey rendered on map

---

### Test 12.2: `should import DMP v5 file with LRUD`

**Purpose:** Verify importing v5 format preserves LRUD data.

**Test Code:**
```typescript
it('should import DMP v5 file with LRUD', async () => {
  // Create project
  const newProjectBtn = await $('button*=New Project');
  await newProjectBtn.click();
  await $('input[type="text"]').setValue('DMP v5 Test');
  await $('button*=Create').click();
  await browser.waitUntil(async () => (await $('canvas')).isDisplayed(), { timeout: 10000 });

  // Import v5 file
  await browser.keys(['Control', 'i']);
  const importDialog = await $('[role="dialog"]');
  await importDialog.waitForDisplayed();

  const fileInput = await $('input[type="file"]');
  await fileInput.setValue(path.resolve(__dirname, '../fixtures/test_v5.dmp'));

  await browser.waitUntil(
    async () => (await $('[data-testid="shot-table"]')).isDisplayed(),
    { timeout: 5000 }
  );

  // Verify LRUD columns exist in table
  const headers = await $$('[data-testid="shot-table"] th');
  const headerTexts = await Promise.all(headers.map(h => h.getText()));

  expect(headerTexts.some(t => /left|L/i.test(t))).toBe(true);
  expect(headerTexts.some(t => /right|R/i.test(t))).toBe(true);
  expect(headerTexts.some(t => /up|U/i.test(t))).toBe(true);
  expect(headerTexts.some(t => /down|D/i.test(t))).toBe(true);

  // Verify LRUD values in first row
  const firstRow = await $('[data-testid="shot-table"] tbody tr');
  const cells = await firstRow.$$('td');
  const cellTexts = await Promise.all(cells.map(c => c.getText()));

  // Should have numeric LRUD values (not empty, not N/A)
  const hasLrudValues = cellTexts.some(t => /^\d+\.?\d*$/.test(t.trim()));
  expect(hasLrudValues).toBe(true);

  // Import
  await $('button*=Import').click();
  await browser.waitUntil(async () => !(await importDialog.isDisplayed()), { timeout: 5000 });

  // Open detail panel and select a shot to verify LRUD preserved
  await browser.keys(['Control', '2']);
  const detailPanel = await $('[data-testid="detail-panel"]');
  await detailPanel.waitForDisplayed();

  // Select first shot
  const shotItem = await $('[data-testid="shot-item"]');
  await shotItem.click();

  // Verify LRUD fields in detail panel
  const leftInput = await $('[data-testid="shot-left-input"]');
  expect(await leftInput.isDisplayed()).toBe(true);
  expect(await leftInput.getValue()).not.toBe('');
});
```

**Assertions:**
- [ ] V5 file parses
- [ ] LRUD columns in table
- [ ] LRUD values populated
- [ ] LRUD preserved after import
- [ ] LRUD visible in detail panel

---

### Test 12.3: `should handle corrupted DMP file gracefully`

**Purpose:** Verify the app shows helpful error for corrupted files.

**Test Code:**
```typescript
it('should handle corrupted DMP file gracefully', async () => {
  // Create project
  await createTestProject('Corrupted Test');

  // Import corrupted file
  await browser.keys(['Control', 'i']);
  const importDialog = await $('[role="dialog"]');
  await importDialog.waitForDisplayed();

  // Create a corrupted file (or use existing corrupted fixture)
  const fileInput = await $('input[type="file"]');
  await fileInput.setValue(path.resolve(__dirname, '../fixtures/corrupted.dmp'));

  // Wait for error to appear
  await browser.waitUntil(
    async () => {
      const error = await $('[data-testid="import-error"], [role="alert"]');
      return error.isDisplayed();
    },
    { timeout: 5000, timeoutMsg: 'Error message did not appear' }
  );

  // Verify error message is helpful
  const errorMsg = await $('[data-testid="import-error"], [role="alert"]');
  const errorText = await errorMsg.getText();
  expect(errorText.toLowerCase()).toMatch(/invalid|corrupt|parse|error/);

  // Dialog should stay open for user to try different file
  expect(await importDialog.isDisplayed()).toBe(true);

  // Can cancel without crash
  const cancelBtn = await $('button*=Cancel');
  await cancelBtn.click();
  await browser.waitUntil(async () => !(await importDialog.isDisplayed()), { timeout: 3000 });

  // App should remain functional
  const canvas = await $('canvas');
  expect(await canvas.isDisplayed()).toBe(true);
});

async function createTestProject(name: string) {
  const newProjectBtn = await $('button*=New Project');
  await newProjectBtn.click();
  await $('input[type="text"]').setValue(name);
  await $('button*=Create').click();
  await browser.waitUntil(async () => (await $('canvas')).isDisplayed(), { timeout: 10000 });
}
```

**Assertions:**
- [ ] Error shown for corrupted file
- [ ] Error message is helpful
- [ ] Dialog stays open
- [ ] Can cancel dialog
- [ ] App remains functional

---

### Test 12.4: `should import multiple sections from multi-section DMP`

**Purpose:** Verify files with multiple sections import correctly.

**Test Code:**
```typescript
it('should import multiple sections from multi-section DMP', async () => {
  await createTestProject('Multi-Section Test');

  await browser.keys(['Control', 'i']);
  await $('[role="dialog"]').waitForDisplayed();

  // Use a DMP with multiple sections
  // (May need to create this fixture or use existing multi-section file)
  const fileInput = await $('input[type="file"]');
  await fileInput.setValue(path.resolve(__dirname, '../fixtures/multi_section.dmp'));

  await browser.waitUntil(
    async () => (await $('[data-testid="shot-table"]')).isDisplayed(),
    { timeout: 5000 }
  );

  // Verify section selector shows multiple sections
  const sectionSelector = await $('[data-testid="section-selector"]');
  await sectionSelector.waitForDisplayed();

  const sectionOptions = await $$('[data-testid="section-option"]');
  expect(sectionOptions.length).toBeGreaterThan(1);

  // Check all sections checkbox
  const selectAll = await $('[data-testid="select-all-sections"]');
  if (await selectAll.isDisplayed()) {
    await selectAll.click();
  }

  // Import all sections
  await $('button*=Import').click();
  await browser.waitUntil(async () => !(await $('[role="dialog"]').isDisplayed()), { timeout: 5000 });

  // Verify all sections appear in panel
  const sectionHeaders = await $$('[data-testid="section-header"]');
  expect(sectionHeaders.length).toBeGreaterThan(1);
});
```

**Assertions:**
- [ ] Multi-section file parses
- [ ] Section selector shows all sections
- [ ] Can select which sections to import
- [ ] All selected sections imported
- [ ] Multiple sections in panel

---

### Test 12.5: `should preserve section metadata from DMP`

**Purpose:** Verify section name, date, and surveyor are extracted from DMP.

**Test Code:**
```typescript
it('should preserve section metadata from DMP', async () => {
  await createTestProject('Metadata Test');

  await browser.keys(['Control', 'i']);
  await $('[role="dialog"]').waitForDisplayed();

  await $('input[type="file"]').setValue(path.resolve(__dirname, '../fixtures/test_v5.dmp'));

  await browser.waitUntil(
    async () => (await $('[data-testid="shot-table"]')).isDisplayed(),
    { timeout: 5000 }
  );

  // Check section name in dialog
  const sectionNameDisplay = await $('[data-testid="section-name"]');
  const sectionName = await sectionNameDisplay.getText();
  expect(sectionName.trim().length).toBeGreaterThan(0);

  // Check date if displayed
  const dateDisplay = await $('[data-testid="section-date"]');
  if (await dateDisplay.isDisplayed()) {
    const dateText = await dateDisplay.getText();
    // Should be a valid date format
    expect(dateText).toMatch(/\d{4}|\d{1,2}\/\d{1,2}|[A-Z][a-z]{2}\s\d/);
  }

  // Import
  await $('button*=Import').click();
  await browser.waitUntil(async () => !(await $('[role="dialog"]').isDisplayed()), { timeout: 5000 });

  // Verify in sections panel
  const sectionHeader = await $('[data-testid="section-header"]');
  const headerText = await sectionHeader.getText();
  expect(headerText).toContain(sectionName);

  // Open detail panel and select section
  await browser.keys(['Control', '2']);
  await sectionHeader.click();

  // Verify metadata in detail panel
  const detailPanel = await $('[data-testid="detail-panel"]');
  await detailPanel.waitForDisplayed();

  const nameInput = await $('[data-testid="section-name-input"]');
  expect(await nameInput.getValue()).toBe(sectionName);
});
```

**Assertions:**
- [ ] Section name extracted from DMP
- [ ] Date extracted from DMP
- [ ] Surveyor extracted if present
- [ ] Metadata shown in import dialog
- [ ] Metadata preserved after import
- [ ] Metadata editable in detail panel

---

### Test 12.6: `should handle DMP with edge case EOS markers`

**Purpose:** Verify special end-of-section handling works correctly.

**Test Code:**
```typescript
it('should handle DMP with edge case EOS markers', async () => {
  await createTestProject('EOS Edge Case');

  await browser.keys(['Control', 'i']);
  await $('[role="dialog"]').waitForDisplayed();

  // Use the buggy EOS fixture
  await $('input[type="file"]').setValue(
    path.resolve(__dirname, '../fixtures/test_v5_buggy_EOS.dmp')
  );

  // Should parse without hanging or crashing
  const parseStartTime = Date.now();

  await browser.waitUntil(
    async () => {
      const table = await $('[data-testid="shot-table"]');
      const error = await $('[data-testid="import-error"]');
      return table.isDisplayed() || error.isDisplayed();
    },
    { timeout: 10000, timeoutMsg: 'DMP parsing took too long or hung' }
  );

  const parseTime = Date.now() - parseStartTime;
  expect(parseTime).toBeLessThan(5000); // Should parse in under 5 seconds

  // Check if parsed successfully
  const shotTable = await $('[data-testid="shot-table"]');
  if (await shotTable.isDisplayed()) {
    // Verify shots were found
    const shotRows = await $$('[data-testid="shot-table"] tbody tr');
    expect(shotRows.length).toBeGreaterThan(0);

    // Import
    await $('button*=Import').click();
    await browser.waitUntil(async () => !(await $('[role="dialog"]').isDisplayed()), { timeout: 5000 });

    // Verify section created
    const sectionHeader = await $('[data-testid="section-header"]');
    expect(await sectionHeader.isDisplayed()).toBe(true);
  } else {
    // Error is acceptable if file is truly malformed
    const errorMsg = await $('[data-testid="import-error"]');
    expect(await errorMsg.isDisplayed()).toBe(true);
  }
});
```

**Assertions:**
- [ ] EOS edge case file doesn't hang parser
- [ ] Parsing completes in reasonable time
- [ ] Either parses or shows clear error
- [ ] No crash on malformed EOS
- [ ] App remains functional

---

## Test Helper Functions

```typescript
async function createTestProject(name: string) {
  const newProjectBtn = await $('button*=New Project');
  await newProjectBtn.click();
  const nameInput = await $('[data-testid="project-name-input"], input[type="text"]');
  await nameInput.setValue(name);
  await $('button*=Create').click();
  await browser.waitUntil(
    async () => (await $('canvas')).isDisplayed(),
    { timeout: 10000 }
  );
}

async function importDmpFile(filename: string) {
  await browser.keys(['Control', 'i']);
  await $('[role="dialog"]').waitForDisplayed();
  await $('input[type="file"]').setValue(path.resolve(__dirname, '../fixtures', filename));
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
```

---

## Required Fixtures

Ensure these files exist in `e2e/fixtures/`:

| File | Description |
|------|-------------|
| `test_v2.dmp` | Valid DMP version 2 file |
| `test_v5.dmp` | Valid DMP version 5 file with LRUD |
| `test_v5_buggy_EOS.dmp` | V5 file with edge case EOS handling |
| `multi_section.dmp` | DMP with 2+ sections |
| `corrupted.dmp` | Intentionally corrupted DMP |

---

## Verification

```bash
# Build the app first
cd src-tauri && cargo build

# Run tests
CARGO_TARGET_DIR=./src-tauri/target xvfb-run -a pnpm test:e2e --spec e2e/specs/dmp-integration.spec.ts
```

## Definition of Done
- [ ] All 6 tests implemented
- [ ] Tests pass with real backend
- [ ] DMP v2 import tested
- [ ] DMP v5 import tested
- [ ] LRUD preservation tested
- [ ] Multi-section import tested
- [ ] Error handling tested
- [ ] Edge cases tested
- [ ] All required fixtures created
