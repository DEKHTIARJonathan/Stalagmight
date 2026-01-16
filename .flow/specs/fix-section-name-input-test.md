# Fix: "should display section name input field" Test

## Problem

The WebdriverIO test `import-dialog.spec.ts:37` fails with:
```
Expect $(`input[name*="section"], input[name*="name"], input[placeholder*="Section"]`) to be existing
Expected: "existing"
Received: "not existing"
```

## Root Cause

The test calls `openImportDialog()` which triggers `Ctrl+I`, opening **DmpImportDialog** (for importing .dmp files).

However, the section name input with `placeholder="e.g., Main Line"` is in **ImportDialog** (a different component for manually creating sections).

The test is testing the **wrong dialog**.

## Solution

### Component Changes

1. **ImportDialog.tsx**:
   - Update local DialogWrapper to accept and pass through `data-testid` prop
   - Add `data-testid="import-section-dialog"` on `role="dialog"` element
   - Add `data-testid="section-name-input"` to section name input

2. **DmpImportDialog.tsx**:
   - Update DialogWrapper to accept `data-testid` prop
   - Add `data-testid="import-dmp-dialog"` on `role="dialog"` element

### Test Changes

1. **Create new spec file** `import-section-dialog.spec.ts` for ImportDialog tests

2. **Fix ALL helpers** in `e2e/helpers/app.ts`:
   - Replace ALL `browser.pause()` with explicit waits
   - Return boolean from ALL `browser.execute()` calls
   - Update `resetAppState()` to call `closeDialog()` via store
   - Rename `openImportDialog()` → `openDmpImportDialog()`

3. **Rename existing spec** `import-dialog.spec.ts` → `import-dmp-dialog.spec.ts`

4. **Handle stale elements** properly in close verification

### Documentation Changes

1. **TESTING.md**: Update dialog shortcuts and close behaviors

## Key Decisions

| Decision | Choice |
|----------|--------|
| data-testid placement | On `role="dialog"` element via DialogWrapper prop |
| Test close method | Cancel button (no Escape dependency) |
| browser.execute | ALL calls return boolean only |
| Wait strategy | Replace ALL `browser.pause()` with explicit waits |
| Stale element handling | Re-query element or use `waitUntil` with try/catch |

## Files to Change

| File | Change |
|------|--------|
| `src/components/Dialogs/ImportDialog.tsx` | Add data-testid support to DialogWrapper, add testids |
| `src/components/Dialogs/DmpImportDialog.tsx` | Add data-testid support to DialogWrapper |
| `e2e/helpers/app.ts` | Fix ALL helpers: no pause, boolean returns, closeDialog in reset |
| `e2e/specs/import-dialog.spec.ts` | Rename to `import-dmp-dialog.spec.ts` |
| `e2e/specs/import-section-dialog.spec.ts` | **Create** new spec |
| `TESTING.md` | Update dialog documentation |

## Implementation Details

### DialogWrapper with data-testid Support

```tsx
// In ImportDialog.tsx - update local DialogWrapper
interface DialogWrapperProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  'data-testid'?: string;  // ADD THIS
}

function DialogWrapper({ title, onClose, children, 'data-testid': testId }: DialogWrapperProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        data-testid={testId}  // ADD THIS
        className="relative bg-panel border border-border rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-auto"
      >
        {/* ... rest unchanged ... */}
      </div>
    </div>
  );
}

// Usage:
<DialogWrapper title="Import / Create Section" onClose={closeDialog} data-testid="import-section-dialog">
```

### Fixed Helpers (ALL browser.pause removed, ALL execute returns boolean)

```typescript
// e2e/helpers/app.ts

export async function waitForAppReady(): Promise<void> {
  // NO browser.pause() - use explicit waits only
  await browser.waitUntil(
    async () => {
      const globalView = await $('[data-testid="global-view"]');
      if (await globalView.isExisting()) return true;
      const canvas = await $('canvas');
      return await canvas.isExisting();
    },
    { timeout: 30000, timeoutMsg: 'Application did not load within 30 seconds' }
  );
}

export async function resetAppState(): Promise<void> {
  // Close dialogs via store - return nothing (not object)
  await browser.execute(() => {
    const e2e = (window as any).__E2E_TEST__;
    if (e2e) {
      e2e.uiStore.getState().closeDialog();
      e2e.projectStore.getState().closeProject();
      e2e.uiStore.getState().setView('global');
    }
  });

  await browser.waitUntil(
    async () => {
      const globalView = await $('[data-testid="global-view"]');
      return await globalView.isExisting();
    },
    { timeout: 5000, timeoutMsg: 'Failed to return to GlobalView after reset' }
  );
}

export async function createNewProject(projectName: string): Promise<void> {
  // Wait for button - NO pause
  const newProjectBtn = await $('[data-testid="new-project-button"]');
  await newProjectBtn.waitForDisplayed({ timeout: 10000 });

  // Wait for E2E store - return BOOLEAN
  await browser.waitUntil(
    async () => await browser.execute(() => !!(window as any).__E2E_TEST__),
    { timeout: 10000, timeoutMsg: 'E2E helpers not available' }
  );

  // Open dialog - NO return value
  await browser.execute(() => {
    (window as any).__E2E_TEST__.uiStore.getState().openDialog('new-project');
  });

  // Wait for dialog - NO pause
  const dialog = await $('[role="dialog"]');
  await dialog.waitForDisplayed({ timeout: 15000 });

  // Fill and submit
  const nameInput = await dialog.$('input[type="text"]');
  await nameInput.waitForEnabled({ timeout: 5000 });
  await nameInput.setValue(projectName);

  const createBtn = await dialog.$('button*=Create');
  await createBtn.waitForDisplayed({ timeout: 5000 });
  await createBtn.click();

  // Wait for SingleSystemView - NO pause
  await browser.waitUntil(
    async () => {
      const map = await $('canvas');
      return await map.isExisting();
    },
    { timeout: 15000, timeoutMsg: 'SingleSystemView did not appear' }
  );
}

export async function openDmpImportDialog(): Promise<void> {
  await browser.keys(['Control', 'i']);
  const dialog = await $('[data-testid="import-dmp-dialog"]');
  await dialog.waitForDisplayed({ timeout: 5000 });
}

export async function closeDialog(): Promise<void> {
  // Use store to close - most reliable
  await browser.execute(() => {
    const e2e = (window as any).__E2E_TEST__;
    if (e2e) {
      e2e.uiStore.getState().closeDialog();
    }
  });

  // Verify closed - handle stale element
  await browser.waitUntil(
    async () => {
      try {
        const dialog = await $('[role="dialog"]');
        return !(await dialog.isDisplayed());
      } catch {
        return true;  // Element gone = dialog closed
      }
    },
    { timeout: 5000 }
  );
}
```

### New Test File (Stale Element Handled)

```typescript
// e2e/specs/import-section-dialog.spec.ts
import { waitForAppReady, resetAppState, createNewProject, closeDialog } from '../helpers/app';

describe('Import Section Dialog', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
  });

  it('should display section name input field', async () => {
    await createNewProject('Section Name Test');

    // Wait for E2E store
    await browser.waitUntil(
      async () => await browser.execute(() => !!(window as any).__E2E_TEST__),
      { timeout: 2000, timeoutMsg: 'E2E store not available' }
    );

    // Open ImportDialog (not DmpImportDialog)
    await browser.execute(() => {
      (window as any).__E2E_TEST__.uiStore.getState().openDialog('import');
    });

    // Wait for dialog
    const dialog = await $('[data-testid="import-section-dialog"]');
    await dialog.waitForDisplayed({ timeout: 2000 });

    // Validate input
    const sectionNameInput = await $('[data-testid="section-name-input"]');
    await expect(sectionNameInput).toBeExisting();

    const placeholder = await sectionNameInput.getAttribute('placeholder');
    expect(placeholder).toBe('e.g., Main Line');

    await sectionNameInput.setValue('Main Passage');
    const value = await sectionNameInput.getValue();
    expect(value).toBe('Main Passage');

    // Close with Cancel
    const cancelBtn = await dialog.$('button*=Cancel');
    await cancelBtn.click();

    // Verify closed - handle stale element
    await browser.waitUntil(
      async () => {
        try {
          const d = await $('[data-testid="import-section-dialog"]');
          return !(await d.isDisplayed());
        } catch {
          return true;
        }
      },
      { timeout: 2000 }
    );
  });
});
```

## Acceptance Criteria

- [ ] ImportDialog DialogWrapper accepts `data-testid` prop
- [ ] ImportDialog has `data-testid="section-name-input"` on input
- [ ] ImportDialog has `data-testid="import-section-dialog"` on dialog
- [ ] DmpImportDialog has `data-testid="import-dmp-dialog"` on dialog
- [ ] ALL `browser.pause()` removed from `e2e/helpers/app.ts`
- [ ] ALL `browser.execute()` return boolean only (not objects)
- [ ] `resetAppState()` calls `closeDialog()` via store
- [ ] `openImportDialog()` renamed to `openDmpImportDialog()`
- [ ] `closeDialog()` handles stale elements
- [ ] New `import-section-dialog.spec.ts` created
- [ ] Old spec renamed to `import-dmp-dialog.spec.ts`
- [ ] TESTING.md updated
- [ ] All WebdriverIO tests pass
- [ ] Playwright tests unaffected

## Quick Commands

```bash
export CARGO_TARGET_DIR=/root/CaveChef/src-tauri/target
export SKIP_BUILD=1
xvfb-run --auto-servernum pnpm wdio run wdio.conf.ts --spec ./e2e/specs/import-section-dialog.spec.ts
```
