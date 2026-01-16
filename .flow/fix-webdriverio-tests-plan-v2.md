# Plan: Fix Two Failing WebdriverIO E2E Tests (v2)

## Summary

Two WebdriverIO E2E tests in `e2e/specs/import-dialog.spec.ts` are failing:
1. **"should display section name input field"** - Testing wrong dialog
2. **"should allow keyboard shortcut to open import dialog"** - Escape doesn't close dialogs

## Test 1: "should display section name input field"

### Root Cause Analysis (REVISED)

**Test code** (import-dialog.spec.ts:37-55):
```typescript
it('should display section name input field', async () => {
  await createNewProject('Section Name Test');
  await openImportDialog();  // <-- Opens DMP Import dialog via Ctrl+I

  const sectionNameInput = await $(
    'input[name*="section"], input[name*="name"], input[placeholder*="Section"]'
  );
  await expect(sectionNameInput).toBeExisting();
  ...
});
```

**The `openImportDialog()` helper** calls `browser.keys(['Control', 'i'])` which triggers `openDialog('import-dmp')` (useKeyboardShortcuts.ts:103), opening **DmpImportDialog**.

**But the section name input** with `placeholder="e.g., Main Line"` is in **ImportDialog** (a different component for manually creating sections).

**Problem**: The test is testing the **wrong dialog**. DmpImportDialog is for importing .dmp files and has different fields.

### Fix

The test should either:
1. **Test the correct dialog (ImportDialog)** - opened via clicking "+" in SectionsPanel, or
2. **Test DmpImportDialog fields** - which has a file path input, not a section name input

**Recommended: Option 1** - Update the test to open ImportDialog correctly:

```typescript
it('should display section name input field', async () => {
  await createNewProject('Section Name Test');

  // Open ImportDialog (not DmpImportDialog) via E2E store
  await browser.execute(() => {
    const e2e = (window as any).__E2E_TEST__;
    if (e2e) {
      e2e.uiStore.getState().openDialog('import');
    }
  });
  await browser.pause(500);

  // ImportDialog has section name input with placeholder "e.g., Main Line"
  const sectionNameInput = await $('[data-testid="section-name-input"]');
  await expect(sectionNameInput).toBeExisting();
  ...
});
```

**Also add `data-testid`** to ImportDialog for reliable selection:

```tsx
// ImportDialog.tsx line 62
<input
  type="text"
  data-testid="section-name-input"
  value={name}
  onChange={(e) => setName(e.target.value)}
  className="w-full"
  placeholder="e.g., Main Line"
/>
```

**Add `data-testid` to dialog wrapper** for consistency:
```tsx
// ImportDialog.tsx DialogWrapper
<div role="dialog" aria-modal="true" aria-labelledby="dialog-title"
     data-testid="import-dialog"
     className="...">
```

### Files to Change

1. `src/components/Dialogs/ImportDialog.tsx`:
   - Add `data-testid="section-name-input"` to section name input (line 62)
   - Add `data-testid="import-dialog"` to dialog wrapper (line 235)

2. `e2e/specs/import-dialog.spec.ts`:
   - Update test to open `'import'` dialog instead of using `openImportDialog()`
   - Update selector to `[data-testid="section-name-input"]`

3. `e2e/helpers/app.ts`:
   - Add new helper `openSectionDialog()` that opens the correct dialog

---

## Test 2: "should allow keyboard shortcut to open import dialog"

### Root Cause Analysis (REVISED)

**Test code** (import-dialog.spec.ts:77-96):
```typescript
it('should allow keyboard shortcut to open import dialog', async () => {
  await createNewProject('Keyboard Test');
  await browser.keys(['Control', 'i']);  // Opens dialog - works

  const dialog = await $('[role="dialog"]');
  await dialog.waitForDisplayed({ timeout: 5000 });  // Works

  await browser.keys(['Escape']);  // <-- Escape does NOT close dialogs!

  await browser.waitUntil(
    async () => !(await dialog.isDisplayed()),
    { timeout: 5000 }  // <-- TIMES OUT
  );
});
```

**The Escape handler** (useKeyboardShortcuts.ts:114-121):
```typescript
if (key === 'escape') {
  clearSelection();
  clearMergeStations();
  clearMeasure();
  setDrawFromStation(null);
  return;  // Does NOT call closeDialog()!
}
```

**Problem**: The app does NOT close dialogs on Escape key. The test assumption is wrong.

### Fix Options

**Option A: Implement Escape-to-close in dialogs (Recommended)**

Add an Escape keydown handler to DialogWrapper that calls `closeDialog()`:

```tsx
// Add to DialogWrapper in ImportDialog.tsx (and shared DialogWrapper if exists)
useEffect(() => {
  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };
  document.addEventListener('keydown', handleEscape);
  return () => document.removeEventListener('keydown', handleEscape);
}, [onClose]);
```

This is good UX and matches user expectations.

**Option B: Update test to close via button**

If Escape-to-close is not desired behavior:
```typescript
// Click the close button instead
const closeBtn = await dialog.$('button:has-text("×")');
await closeBtn.click();
```

### Recommendation

**Option A** - Implement Escape-to-close because:
1. Standard UX expectation for modal dialogs
2. ContextMenu already implements this pattern (ContextMenu.tsx:35-48)
3. Improves overall app usability

### Files to Change

1. `src/components/Dialogs/ImportDialog.tsx`:
   - Add Escape keydown handler to DialogWrapper component

2. Create shared `DialogWrapper` component if one doesn't exist, or update each dialog to use consistent Escape handling.

---

## Implementation Plan

### Step 1: Create/Update Shared DialogWrapper (if needed)

Check if there's a shared DialogWrapper. If not, add Escape handling to ImportDialog's local DialogWrapper:

```tsx
function DialogWrapper({ title, onClose, children }: DialogWrapperProps) {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* ... existing code ... */}
    </div>
  );
}
```

### Step 2: Add test IDs to ImportDialog

```tsx
// ImportDialog.tsx
<input
  type="text"
  data-testid="section-name-input"  // ADD THIS
  value={name}
  ...
/>

// In DialogWrapper:
<div role="dialog" aria-modal="true" aria-labelledby="dialog-title"
     data-testid="import-dialog"  // ADD THIS
     className="...">
```

### Step 3: Update E2E Test for "section name input"

```typescript
// import-dialog.spec.ts
it('should display section name input field', async () => {
  await createNewProject('Section Name Test');

  // Wait for E2E helpers
  await browser.waitUntil(
    async () => !!(await browser.execute(() => (window as any).__E2E_TEST__)),
    { timeout: 10000 }
  );

  // Open the correct dialog (ImportDialog, not DmpImportDialog)
  await browser.execute(() => {
    const e2e = (window as any).__E2E_TEST__;
    e2e.uiStore.getState().openDialog('import');
  });

  await browser.pause(500);

  const sectionNameInput = await $('[data-testid="section-name-input"]');
  await expect(sectionNameInput).toBeExisting();

  await sectionNameInput.setValue('Main Passage');
  const value = await sectionNameInput.getValue();
  expect(value).toBe('Main Passage');

  await closeDialog();
});
```

### Step 4: Update closeDialog helper

```typescript
// e2e/helpers/app.ts
export async function closeDialog(): Promise<void> {
  // Wait for E2E helpers
  await browser.waitUntil(
    async () => !!(await browser.execute(() => (window as any).__E2E_TEST__)),
    { timeout: 5000 }
  );

  // Try Escape first (now that dialogs support it)
  await browser.keys(['Escape']);
  await browser.pause(500);

  // Verify dialog closed, fallback to store if needed
  const dialog = await $('[role="dialog"]');
  if (await dialog.isDisplayed()) {
    await browser.execute(() => {
      const e2e = (window as any).__E2E_TEST__;
      if (e2e) {
        e2e.uiStore.getState().closeDialog();
      }
    });
    await browser.pause(300);
  }
}
```

### Step 5: Verify Fixes

```bash
export CARGO_TARGET_DIR=/root/CaveChef/src-tauri/target
export SKIP_BUILD=1
xvfb-run --auto-servernum pnpm wdio run wdio.conf.ts --spec ./e2e/specs/import-dialog.spec.ts
```

---

## Risk Assessment

| Change | Risk | Mitigation |
|--------|------|------------|
| Adding Escape handler to dialogs | Low | Standard UX, matches ContextMenu pattern |
| Adding data-testid attributes | Very Low | No behavior change |
| Changing test to open different dialog | Medium | Verify test still tests intended functionality |
| Updating closeDialog helper | Low | Maintains backward compatibility with fallback |

---

## Acceptance Criteria

- [ ] ImportDialog has `data-testid="section-name-input"` on section name input
- [ ] ImportDialog has `data-testid="import-dialog"` on dialog wrapper
- [ ] Dialogs close on Escape key press
- [ ] Test "should display section name input field" opens ImportDialog (not DmpImportDialog)
- [ ] Test "should display section name input field" passes
- [ ] Test "should allow keyboard shortcut to open import dialog" passes
- [ ] All other WebdriverIO tests continue to pass (37 tests)
- [ ] Playwright tests unaffected (34 tests)
- [ ] Rust backend tests unaffected (79 tests)
