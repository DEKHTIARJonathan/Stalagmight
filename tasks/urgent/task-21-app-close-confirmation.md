# Task 21: Implement App Close Confirmation During Import

## Description

Show a confirmation dialog when the user tries to close the app window while the import dialog is open. Warn that placed sections will be removed.

## Files to Modify

- `src/App.tsx`
- `src-tauri/src/main.rs` (or equivalent)
- `src/hooks/useBeforeUnload.ts` (create if needed)

## Implementation

### 1. Create useBeforeUnload Hook

```tsx
// src/hooks/useBeforeUnload.ts
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { confirm } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function useBeforeUnload(shouldBlock: boolean, message: string) {
  useEffect(() => {
    if (!shouldBlock) return;

    // Handle Tauri window close request
    const unlisten = listen('tauri://close-requested', async (event) => {
      const confirmed = await confirm(message, {
        title: 'Close Application',
        okLabel: 'Discard and Close',
        cancelLabel: 'Cancel',
      });

      if (confirmed) {
        // Allow close
        const appWindow = getCurrentWindow();
        await appWindow.destroy();
      }
      // If not confirmed, window stays open
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, [shouldBlock, message]);
}
```

### 2. Configure Tauri to Not Auto-Close

```rust
// In src-tauri/src/main.rs or lib.rs
// Configure window to emit close-requested event instead of closing
tauri::Builder::default()
    .on_window_event(|event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
            // Prevent default close, emit event instead
            api.prevent_close();
            event.window().emit("tauri://close-requested", ()).unwrap();
        }
    })
```

### 3. Use Hook in App.tsx

```tsx
// In App.tsx
const { importFlow } = useUIStore();
const hasPlacedSections = importFlow?.placedSections?.size > 0;

useBeforeUnload(
  !!importFlow && hasPlacedSections,
  'Import is in progress. Discard all import data and close?'
);
```

### 4. Clean Up on Confirm

If user confirms close:
- Delete all placed sections from backend
- Close the window

```tsx
// Enhanced version
useBeforeUnload(
  !!importFlow && hasPlacedSections,
  'Import is in progress. Discard all import data and close?',
  async () => {
    // Clean up placed sections before close
    for (const index of importFlow.placedSections) {
      const sectionId = getSectionId(index);
      if (sectionId) {
        await deleteSection(sectionId);
      }
    }
  }
);
```

### 5. Also Handle Browser Close (Web Dev Mode)

```tsx
useEffect(() => {
  if (!shouldBlock) return;

  const handleBeforeUnload = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    e.returnValue = message;
    return message;
  };

  window.addEventListener('beforeunload', handleBeforeUnload);
  return () => window.removeEventListener('beforeunload', handleBeforeUnload);
}, [shouldBlock, message]);
```

## Acceptance Criteria

- [ ] Closing app during import shows confirmation
- [ ] Confirmation message mentions discarding import data
- [ ] Cancel keeps the app open
- [ ] Confirm closes the app
- [ ] Placed sections are deleted on confirm
- [ ] Works in Tauri production build
- [ ] Works in dev mode (browser)
- [ ] TypeScript compiles without errors

## Test Suggestions

### Unit Tests (Rust)
1. Test close-requested event is emitted
2. Test prevent_close API works

### Playwright Tests (3-10)
1. Test beforeunload event fires during import (mock)
2. Test confirmation shown (mock dialog)
3. Test cancel keeps app open (mock)

### WebdriverIO Tests (3-10)
1. Test closing window during import shows dialog
2. Test Cancel keeps app and dialog open
3. Test Confirm closes app
4. Test placed sections cleaned up on confirm

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
