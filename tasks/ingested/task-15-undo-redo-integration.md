# Task 15: Undo/Redo Integration Tests (WebdriverIO)

## Overview
| Field | Value |
|-------|-------|
| **Task ID** | task-15 |
| **Category** | WebdriverIO E2E Tests |
| **Target File** | `e2e/specs/undo-redo-integration.spec.ts` (new file) |
| **Tests** | 4 |
| **Priority** | P1 - High |
| **Dependencies** | task-12 (DMP integration), task-14 (persistence) |

## Affected Files
- `e2e/specs/undo-redo-integration.spec.ts` - New test file

## Test Environment

These tests run against the **full Tauri application** with real backend:
```bash
CARGO_TARGET_DIR=./src-tauri/target xvfb-run -a pnpm test:e2e --spec e2e/specs/undo-redo-integration.spec.ts
```

## Test Specifications

---

### Test 15.1: `should undo shot edit with Ctrl+Z`

**Purpose:** Verify Ctrl+Z undoes the most recent shot edit.

**Test Code:**
```typescript
import { browser, expect } from '@wdio/globals';
import * as path from 'path';

describe('Undo/Redo Integration', () => {
  beforeEach(async () => {
    await browser.waitUntil(
      async () => (await $('body')).isDisplayed(),
      { timeout: 30000 }
    );
  });

  it('should undo shot edit with Ctrl+Z', async () => {
    await createProjectAndImport('Undo Test', 'test_v5.dmp');

    // Open detail panel and select first shot
    await browser.keys(['Control', '2']);
    const detailPanel = await $('[data-testid="detail-panel"]');
    await detailPanel.waitForDisplayed();

    const shotItem = await $('[data-testid="shot-item"]');
    await shotItem.click();

    // Get original length value
    const lengthInput = await $('[data-testid="shot-length-input"]');
    const originalValue = await lengthInput.getValue();
    expect(originalValue).not.toBe('');

    // Change the length
    await lengthInput.clearValue();
    await lengthInput.setValue('99.99');
    await browser.keys(['Tab']); // Trigger save

    await browser.pause(300);

    // Verify value changed
    const changedValue = await lengthInput.getValue();
    expect(changedValue).toBe('99.99');

    // Undo with Ctrl+Z
    await browser.keys(['Control', 'z']);

    await browser.pause(500);

    // Verify value reverted
    // Need to re-select the shot as selection may have changed
    await shotItem.click();
    const revertedValue = await $('[data-testid="shot-length-input"]').getValue();
    expect(revertedValue).toBe(originalValue);
  });
});
```

**Assertions:**
- [ ] Ctrl+Z undoes last change
- [ ] Shot value reverts to original
- [ ] UI updates to show reverted value
- [ ] Undo is immediate

---

### Test 15.2: `should redo undone action with Ctrl+Y`

**Purpose:** Verify Ctrl+Y redoes the last undone action.

**Test Code:**
```typescript
it('should redo undone action with Ctrl+Y', async () => {
  await createProjectAndImport('Redo Test', 'test_v5.dmp');

  await browser.keys(['Control', '2']);
  const shotItem = await $('[data-testid="shot-item"]');
  await shotItem.click();

  const lengthInput = await $('[data-testid="shot-length-input"]');
  const originalValue = await lengthInput.getValue();

  // Make a change
  await lengthInput.clearValue();
  await lengthInput.setValue('50.5');
  await browser.keys(['Tab']);
  await browser.pause(300);

  // Undo
  await browser.keys(['Control', 'z']);
  await browser.pause(300);

  // Verify undone
  await shotItem.click();
  expect(await $('[data-testid="shot-length-input"]').getValue()).toBe(originalValue);

  // Redo with Ctrl+Y
  await browser.keys(['Control', 'y']);
  await browser.pause(300);

  // Verify redone
  await shotItem.click();
  const redoneValue = await $('[data-testid="shot-length-input"]').getValue();
  expect(redoneValue).toBe('50.5');
});

it('should also redo with Ctrl+Shift+Z', async () => {
  await createProjectAndImport('Redo Alt Test', 'test_v5.dmp');

  await browser.keys(['Control', '2']);
  const shotItem = await $('[data-testid="shot-item"]');
  await shotItem.click();

  const lengthInput = await $('[data-testid="shot-length-input"]');
  const originalValue = await lengthInput.getValue();

  // Make a change
  await lengthInput.clearValue();
  await lengthInput.setValue('33.3');
  await browser.keys(['Tab']);
  await browser.pause(300);

  // Undo
  await browser.keys(['Control', 'z']);
  await browser.pause(300);

  // Redo with Ctrl+Shift+Z
  await browser.keys(['Control', 'Shift', 'z']);
  await browser.pause(300);

  // Verify redone
  await shotItem.click();
  const redoneValue = await $('[data-testid="shot-length-input"]').getValue();
  expect(redoneValue).toBe('33.3');
});
```

**Assertions:**
- [ ] Ctrl+Y redoes
- [ ] Ctrl+Shift+Z also redoes
- [ ] Redo restores the change
- [ ] UI updates correctly

---

### Test 15.3: `should undo multiple changes in sequence`

**Purpose:** Verify multiple changes can be undone in reverse order.

**Test Code:**
```typescript
it('should undo multiple changes in sequence', async () => {
  await createProjectAndImport('Multi-Undo Test', 'test_v5.dmp');

  await browser.keys(['Control', '2']);

  // Get shot items
  const shotItems = await $$('[data-testid="shot-item"]');
  expect(shotItems.length).toBeGreaterThan(1);

  // Make change to shot 1
  await shotItems[0].click();
  const lengthInput1 = await $('[data-testid="shot-length-input"]');
  const original1 = await lengthInput1.getValue();
  await lengthInput1.clearValue();
  await lengthInput1.setValue('11.1');
  await browser.keys(['Tab']);
  await browser.pause(300);

  // Make change to shot 2
  await shotItems[1].click();
  const lengthInput2 = await $('[data-testid="shot-length-input"]');
  const original2 = await lengthInput2.getValue();
  await lengthInput2.clearValue();
  await lengthInput2.setValue('22.2');
  await browser.keys(['Tab']);
  await browser.pause(300);

  // Make another change to shot 1
  await shotItems[0].click();
  await $('[data-testid="shot-length-input"]').clearValue();
  await $('[data-testid="shot-length-input"]').setValue('33.3');
  await browser.keys(['Tab']);
  await browser.pause(300);

  // Undo 3 times
  await browser.keys(['Control', 'z']); // Undo 33.3 -> 11.1
  await browser.pause(200);
  await browser.keys(['Control', 'z']); // Undo 22.2 -> original2
  await browser.pause(200);
  await browser.keys(['Control', 'z']); // Undo 11.1 -> original1
  await browser.pause(200);

  // Verify shot 1 is back to original
  await shotItems[0].click();
  expect(await $('[data-testid="shot-length-input"]').getValue()).toBe(original1);

  // Verify shot 2 is back to original
  await shotItems[1].click();
  expect(await $('[data-testid="shot-length-input"]').getValue()).toBe(original2);
});
```

**Assertions:**
- [ ] Multiple undos work
- [ ] Changes undone in LIFO order
- [ ] Each undo reverts one operation
- [ ] All values return to original

---

### Test 15.4: `should clear redo stack on new command`

**Purpose:** Verify new changes clear the redo stack.

**Test Code:**
```typescript
it('should clear redo stack on new command', async () => {
  await createProjectAndImport('Clear Redo Test', 'test_v5.dmp');

  await browser.keys(['Control', '2']);
  const shotItem = await $('[data-testid="shot-item"]');
  await shotItem.click();

  const lengthInput = await $('[data-testid="shot-length-input"]');

  // Change A: 10.0
  await lengthInput.clearValue();
  await lengthInput.setValue('10.0');
  await browser.keys(['Tab']);
  await browser.pause(300);

  // Undo A
  await browser.keys(['Control', 'z']);
  await browser.pause(300);

  // Now redo stack has A
  // Make new change B: 20.0 (should clear redo stack)
  await shotItem.click();
  const lengthInputAgain = await $('[data-testid="shot-length-input"]');
  await lengthInputAgain.clearValue();
  await lengthInputAgain.setValue('20.0');
  await browser.keys(['Tab']);
  await browser.pause(300);

  // Try to redo - should do nothing (redo stack cleared)
  await browser.keys(['Control', 'y']);
  await browser.pause(300);

  // Value should still be 20.0 (not 10.0)
  await shotItem.click();
  const currentValue = await $('[data-testid="shot-length-input"]').getValue();
  expect(currentValue).toBe('20.0');

  // Undo should now undo B (20.0 -> original)
  await browser.keys(['Control', 'z']);
  await browser.pause(300);

  await shotItem.click();
  const afterUndo = await $('[data-testid="shot-length-input"]').getValue();
  expect(afterUndo).not.toBe('20.0');
  expect(afterUndo).not.toBe('10.0'); // A was lost when B was made
});
```

**Assertions:**
- [ ] New command clears redo stack
- [ ] Cannot redo after new command
- [ ] Undo only affects commands after redo clear
- [ ] Lost changes stay lost

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
CARGO_TARGET_DIR=./src-tauri/target xvfb-run -a pnpm test:e2e --spec e2e/specs/undo-redo-integration.spec.ts
```

## Definition of Done
- [ ] All 4 tests implemented
- [ ] Tests pass with real backend
- [ ] Single undo tested
- [ ] Redo tested (both shortcuts)
- [ ] Multiple undos tested
- [ ] Redo stack clearing tested
