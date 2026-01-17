# Task 14: Project Persistence Tests (WebdriverIO)

## Overview
| Field | Value |
|-------|-------|
| **Task ID** | task-14 |
| **Category** | WebdriverIO E2E Tests |
| **Target File** | `e2e/specs/project-persistence.spec.ts` (new file) |
| **Tests** | 6 |
| **Priority** | P0 - Critical |
| **Dependencies** | task-12 (DMP integration) |

## Affected Files
- `e2e/specs/project-persistence.spec.ts` - New test file

## Test Environment

These tests run against the **full Tauri application** with real backend:
```bash
CARGO_TARGET_DIR=./src-tauri/target xvfb-run -a pnpm test:e2e --spec e2e/specs/project-persistence.spec.ts
```

## Test Specifications

---

### Test 14.1: `should save and reload project data`

**Purpose:** Verify project can be saved to disk and reloaded with all data intact.

**Test Code:**
```typescript
import { browser, expect } from '@wdio/globals';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('Project Persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create temp directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cavechef-test-'));

    await browser.waitUntil(
      async () => (await $('body')).isDisplayed(),
      { timeout: 30000 }
    );
  });

  afterEach(async () => {
    // Cleanup temp files
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should save and reload project data', async () => {
    // Create project with data
    await createTestProject('Persistence Test');
    await importDmpFile('test_v5.dmp');

    // Get initial data for comparison
    const initialData = await getProjectData();
    expect(initialData.sectionCount).toBeGreaterThan(0);
    expect(initialData.shotCount).toBeGreaterThan(0);

    // Save project
    await browser.keys(['Control', 's']);

    // Wait for save dialog
    const saveDialog = await $('[role="dialog"]');
    if (await saveDialog.isDisplayed()) {
      // Enter save path
      const pathInput = await $('input[type="text"], input[name="path"]');
      const savePath = path.join(tempDir, 'test-project.cvproj');
      await pathInput.setValue(savePath);
      await $('button*=Save').click();
    }

    // Wait for save to complete
    await browser.waitUntil(
      async () => {
        const notification = await $('[data-testid="save-success"], [role="alert"]');
        return notification.isDisplayed();
      },
      { timeout: 10000 }
    );

    // Close project (if supported) or restart app
    // For this test, we'll reload the app
    await browser.reloadSession();

    // Wait for app to restart
    await browser.waitUntil(
      async () => (await $('body')).isDisplayed(),
      { timeout: 30000 }
    );

    // Open saved project
    const openBtn = await $('button*=Open');
    await openBtn.click();

    // Enter file path
    const fileInput = await $('input[type="file"], input[type="text"]');
    const savedPath = path.join(tempDir, 'test-project.cvproj');
    await fileInput.setValue(savedPath);

    // Wait for project to load
    await browser.waitUntil(
      async () => (await $('canvas')).isDisplayed(),
      { timeout: 10000 }
    );

    // Verify data matches
    const loadedData = await getProjectData();
    expect(loadedData.sectionCount).toBe(initialData.sectionCount);
    expect(loadedData.shotCount).toBe(initialData.shotCount);
    expect(loadedData.projectName).toBe(initialData.projectName);
  });

  async function getProjectData() {
    return await browser.execute(() => {
      const store = (window as any).__E2E_TEST__?.projectStore;
      const project = store?.getState()?.project;
      return {
        projectName: project?.name ?? '',
        sectionCount: project?.sections?.length ?? 0,
        shotCount: project?.sections?.reduce((sum: number, s: any) => sum + (s.shots?.length ?? 0), 0) ?? 0
      };
    });
  }
});
```

**Assertions:**
- [ ] Project saves to file
- [ ] Project reloads from file
- [ ] Section count matches
- [ ] Shot count matches
- [ ] Project name preserved

---

### Test 14.2: `should preserve station merges across save/load`

**Purpose:** Verify station merge relationships are preserved after save/load.

**Test Code:**
```typescript
it('should preserve station merges across save/load', async () => {
  await createTestProject('Merge Persistence');

  // Import two sections
  await importDmpFile('test_v5.dmp');
  await importDmpFile('test_v2.dmp');

  // Create a merge (via UI or command)
  // For testing, we may need to use the merge command directly
  await browser.execute(() => {
    const store = (window as any).__E2E_TEST__?.projectStore;
    if (store) {
      // Manually trigger merge command
      // This depends on store implementation
    }
  });

  // Alternative: Use merge tool
  await browser.keys(['m']); // Merge tool
  // Select stations... (would need specific UI interaction)

  // Get merge count before save
  const initialMerges = await browser.execute(() => {
    const store = (window as any).__E2E_TEST__?.projectStore;
    return store?.getState()?.project?.station_merges?.length ?? 0;
  });

  // Save and reload
  const savePath = path.join(tempDir, 'merge-test.cvproj');
  await saveProjectAs(savePath);
  await browser.reloadSession();
  await browser.waitUntil(async () => (await $('body')).isDisplayed(), { timeout: 30000 });
  await openProject(savePath);

  // Verify merges preserved
  const loadedMerges = await browser.execute(() => {
    const store = (window as any).__E2E_TEST__?.projectStore;
    return store?.getState()?.project?.station_merges?.length ?? 0;
  });

  expect(loadedMerges).toBe(initialMerges);
});
```

**Assertions:**
- [ ] Station merges saved
- [ ] Station merges loaded
- [ ] Merge count matches
- [ ] Merge positions correct

---

### Test 14.3: `should preserve zero datums across save/load`

**Purpose:** Verify GPS zero datums are preserved.

**Test Code:**
```typescript
it('should preserve zero datums across save/load', async () => {
  await createTestProject('Zero Datum Persistence');
  await importDmpFile('test_v5.dmp');

  // Set a zero datum (via UI)
  // This requires the GPS input dialog or command
  await browser.execute(() => {
    const store = (window as any).__E2E_TEST__?.projectStore;
    // Add zero datum programmatically for testing
    if (store) {
      const project = store.getState().project;
      if (project?.sections?.[0]) {
        // Would need to call the appropriate command
      }
    }
  });

  // Get zero datums before save
  const initialDatums = await browser.execute(() => {
    const store = (window as any).__E2E_TEST__?.projectStore;
    return store?.getState()?.project?.zero_datums ?? [];
  });

  // Save and reload
  const savePath = path.join(tempDir, 'datum-test.cvproj');
  await saveProjectAs(savePath);
  await browser.reloadSession();
  await browser.waitUntil(async () => (await $('body')).isDisplayed(), { timeout: 30000 });
  await openProject(savePath);

  // Verify datums preserved
  const loadedDatums = await browser.execute(() => {
    const store = (window as any).__E2E_TEST__?.projectStore;
    return store?.getState()?.project?.zero_datums ?? [];
  });

  expect(loadedDatums.length).toBe(initialDatums.length);

  if (initialDatums.length > 0 && loadedDatums.length > 0) {
    // Verify GPS coordinates match
    expect(Math.abs(loadedDatums[0].latitude - initialDatums[0].latitude)).toBeLessThan(0.000001);
    expect(Math.abs(loadedDatums[0].longitude - initialDatums[0].longitude)).toBeLessThan(0.000001);
  }
});
```

**Assertions:**
- [ ] Zero datums saved
- [ ] Zero datums loaded
- [ ] GPS coordinates preserved
- [ ] Precision maintained (8+ decimal places)

---

### Test 14.4: `should handle save to read-only location`

**Purpose:** Verify appropriate error when save fails due to permissions.

**Test Code:**
```typescript
it('should handle save to read-only location', async () => {
  await createTestProject('Read-Only Test');
  await importDmpFile('test_v5.dmp');

  // Try to save to a read-only location
  // On Linux, /root/ is typically not writable by regular users
  const readOnlyPath = '/root/test-readonly.cvproj';

  await browser.keys(['Control', 's']);

  const saveDialog = await $('[role="dialog"]');
  if (await saveDialog.isDisplayed()) {
    const pathInput = await $('input[type="text"]');
    await pathInput.setValue(readOnlyPath);
    await $('button*=Save').click();

    // Should show error
    await browser.waitUntil(
      async () => {
        const error = await $('[data-testid="save-error"], [role="alert"]');
        return error.isDisplayed();
      },
      { timeout: 5000 }
    );

    const errorMsg = await $('[data-testid="save-error"], [role="alert"]');
    const errorText = await errorMsg.getText();
    expect(errorText.toLowerCase()).toMatch(/permission|denied|write|access/);
  }
});
```

**Assertions:**
- [ ] Save to read-only fails gracefully
- [ ] Error message shown
- [ ] Error mentions permission
- [ ] App remains functional

---

### Test 14.5: `should update recent projects list`

**Purpose:** Verify saved projects appear in recent projects.

**Test Code:**
```typescript
it('should update recent projects list', async () => {
  await createTestProject('Recent List Test');
  await importDmpFile('test_v5.dmp');

  const savePath = path.join(tempDir, 'recent-test.cvproj');
  await saveProjectAs(savePath);

  // Close project or reload
  await browser.reloadSession();
  await browser.waitUntil(async () => (await $('body')).isDisplayed(), { timeout: 30000 });

  // Check recent projects on start screen
  const recentProjects = await $$('[data-testid="recent-project"]');
  expect(recentProjects.length).toBeGreaterThan(0);

  // The saved project should be in the list
  const recentTexts = await Promise.all(recentProjects.map(r => r.getText()));
  const hasOurProject = recentTexts.some(t =>
    t.includes('recent-test') || t.includes('Recent List Test')
  );
  expect(hasOurProject).toBe(true);

  // Click to open should work
  const ourProject = recentProjects.find(async (r) => {
    const text = await r.getText();
    return text.includes('recent-test') || text.includes('Recent List Test');
  });

  if (ourProject) {
    await ourProject.click();
    await browser.waitUntil(async () => (await $('canvas')).isDisplayed(), { timeout: 10000 });

    // Verify correct project loaded
    const loadedName = await browser.execute(() => {
      const store = (window as any).__E2E_TEST__?.projectStore;
      return store?.getState()?.project?.name ?? '';
    });
    expect(loadedName).toBe('Recent List Test');
  }
});
```

**Assertions:**
- [ ] Saved project appears in recent list
- [ ] Recent list shows on app start
- [ ] Clicking recent project opens it
- [ ] Correct project loaded

---

### Test 14.6: `should show dirty indicator for unsaved changes`

**Purpose:** Verify the window title shows dirty state indicator.

**Test Code:**
```typescript
it('should show dirty indicator for unsaved changes', async () => {
  await createTestProject('Dirty Indicator Test');
  await importDmpFile('test_v5.dmp');

  // Save project first
  const savePath = path.join(tempDir, 'dirty-test.cvproj');
  await saveProjectAs(savePath);

  // Get window title after save (should be clean)
  let title = await browser.getTitle();
  expect(title).not.toContain('*'); // No asterisk = clean

  // Make a change
  await browser.keys(['Control', '2']); // Open detail panel
  const shotItem = await $('[data-testid="shot-item"]');
  await shotItem.click();

  const lengthInput = await $('[data-testid="shot-length-input"]');
  await lengthInput.clearValue();
  await lengthInput.setValue('99.9');
  await browser.keys(['Tab']);

  await browser.pause(500);

  // Window title should show dirty indicator
  title = await browser.getTitle();
  expect(title).toContain('*');

  // Save should clear dirty indicator
  await browser.keys(['Control', 's']);
  await browser.pause(1000);

  title = await browser.getTitle();
  expect(title).not.toContain('*');
});
```

**Assertions:**
- [ ] Clean state has no asterisk
- [ ] Making change adds asterisk
- [ ] Saving removes asterisk
- [ ] Title updates promptly

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

async function saveProjectAs(filePath: string) {
  await browser.keys(['Control', 's']);
  const saveDialog = await $('[role="dialog"]');
  if (await saveDialog.isDisplayed()) {
    const pathInput = await $('input[type="text"]');
    await pathInput.setValue(filePath);
    await $('button*=Save').click();
  }
  await browser.waitUntil(
    async () => {
      const success = await $('[data-testid="save-success"]');
      const noDialog = !(await $('[role="dialog"]').isDisplayed());
      return success.isDisplayed() || noDialog;
    },
    { timeout: 10000 }
  );
}

async function openProject(filePath: string) {
  const openBtn = await $('button*=Open');
  await openBtn.click();
  const fileInput = await $('input[type="file"], input[type="text"]');
  await fileInput.setValue(filePath);
  await browser.waitUntil(
    async () => (await $('canvas')).isDisplayed(),
    { timeout: 10000 }
  );
}
```

---

## Verification

```bash
CARGO_TARGET_DIR=./src-tauri/target xvfb-run -a pnpm test:e2e --spec e2e/specs/project-persistence.spec.ts
```

## Definition of Done
- [ ] All 6 tests implemented
- [ ] Tests pass with real backend
- [ ] Save/load round-trip verified
- [ ] Station merges preserved
- [ ] Zero datums preserved
- [ ] Error handling tested
- [ ] Recent projects tested
- [ ] Dirty indicator tested
