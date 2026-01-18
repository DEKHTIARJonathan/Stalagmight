# Task 14: Wire Up Context-Aware Dialog Triggering

## Description

Implement the context-aware triggering of the import flow: from home screen (creates new project) vs from existing project (adds sections). Also handle drag-and-drop of DMP files.

## Files to Modify

- `src/components/GlobalView/GlobalView.tsx`
- `src/components/SingleSystemView/SingleSystemView.tsx`
- `src/hooks/useKeyboardShortcuts.ts`
- `src/store/uiStore.ts`
- `src/App.tsx`

## Implementation

### 1. UI Store Import State

```tsx
interface ImportFlowState {
  step: 'selection' | 'config' | 'placement';
  dmpFile: DmpFile | null;
  filePath: string | null;
  selectionConfig: DmpSelectionConfig | null;
  createNewProject: boolean;
  newProjectName: string | null;
}

// Add to uiStore
importFlow: ImportFlowState | null;
startImportFlow: (filePath: string, dmpFile: DmpFile, createNew: boolean) => void;
setImportStep: (step: ImportFlowState['step']) => void;
setSelectionConfig: (config: DmpSelectionConfig) => void;
endImportFlow: () => void;
```

### 2. Ctrl+I Handler (Keyboard Shortcuts)

```tsx
// In useKeyboardShortcuts.ts
if ((e.ctrlKey || e.metaKey) && key === 'i') {
  e.preventDefault();
  // Open file picker
  const path = await openDmpFilePicker();
  if (!path) return;

  // Parse DMP file
  const dmpFile = await importDmp(path);
  if (!dmpFile) return;

  // Determine context
  const createNew = !project; // No project open = create new

  if (createNew) {
    // Show New Project dialog first
    openDialog('new-project', {
      afterCreate: () => startImportFlow(path, dmpFile, true)
    });
  } else {
    // Start import flow directly
    startImportFlow(path, dmpFile, false);
  }
}
```

### 3. From Home Screen

When triggered from GlobalView (no project):
1. Open file picker
2. Parse DMP
3. Show NewProjectDialog
4. On project created, open DmpSelectionDialog (Step 1)
5. Continue with DmpSectionConfigDialog (Step 2)

```tsx
// In GlobalView.tsx
const handleImportClick = async () => {
  const path = await openDmpFilePicker();
  if (!path) return;

  const dmpFile = await importDmp(path);
  if (!dmpFile) return;

  // Show project name dialog
  openDialog('new-project-for-import', {
    defaultName: extractFilename(path),
    onComplete: (projectName) => {
      createProject(projectName);
      startImportFlow(path, dmpFile, true);
    }
  });
};
```

### 4. From Existing Project

When triggered from SingleSystemView:
1. Open file picker
2. Parse DMP
3. Check for duplicate import (file hash)
4. Open DmpSelectionDialog (Step 1)
5. Continue with DmpSectionConfigDialog (Step 2)

```tsx
// In SingleSystemView.tsx (or useKeyboardShortcuts)
const handleImportClick = async () => {
  const path = await openDmpFilePicker();
  if (!path) return;

  const dmpFile = await importDmp(path);
  if (!dmpFile) return;

  // Check for duplicate
  const hash = await calculateFileHash(path);
  if (project?.importedFileHashes?.includes(hash)) {
    const proceed = await showConfirmDialog({
      title: 'File Already Imported',
      message: 'This DMP file appears to have been imported before. Import again?',
    });
    if (!proceed) return;
  }

  startImportFlow(path, dmpFile, false);
};
```

### 5. Drag and Drop

Handle DMP file drag-and-drop on app window:

```tsx
// In App.tsx
useEffect(() => {
  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (!file?.name.toLowerCase().endsWith('.dmp')) return;

    const path = file.path; // Tauri provides this
    const dmpFile = await importDmp(path);
    if (!dmpFile) return;

    const createNew = !project;
    if (createNew) {
      openDialog('new-project-for-import', {
        defaultName: extractFilename(path),
        onComplete: (projectName) => {
          createProject(projectName);
          startImportFlow(path, dmpFile, true);
        }
      });
    } else {
      startImportFlow(path, dmpFile, false);
    }
  };

  window.addEventListener('drop', handleDrop);
  window.addEventListener('dragover', (e) => e.preventDefault());
  return () => {
    window.removeEventListener('drop', handleDrop);
    window.removeEventListener('dragover', (e) => e.preventDefault());
  };
}, [project]);
```

### 6. App.tsx Dialog Rendering

```tsx
// In App.tsx
{importFlow?.step === 'selection' && (
  <DmpSelectionDialog
    dmpFile={importFlow.dmpFile}
    filePath={importFlow.filePath}
    onCancel={endImportFlow}
    onContinue={(config) => {
      setSelectionConfig(config);
      setImportStep('config');
    }}
  />
)}

{importFlow?.step === 'config' && (
  <DmpSectionConfigDialog
    dmpFile={importFlow.dmpFile}
    selectionConfig={importFlow.selectionConfig}
    onCancel={endImportFlow}
    onBack={() => setImportStep('selection')}
    onImport={handleImportComplete}
    project={project}
    stations={stations}
  />
)}
```

## Acceptance Criteria

- [ ] Ctrl+I from home screen prompts for project name
- [ ] Ctrl+I from existing project opens Step 1 directly
- [ ] Duplicate file check warns user
- [ ] Drag-drop DMP file triggers same flow
- [ ] Drag-drop from home screen creates project
- [ ] Drag-drop to existing project adds sections
- [ ] TypeScript compiles without errors

## Existing Tests to Modify

The following existing test files must be updated to account for changes made in this task:

### Playwright Tests
- `e2e-playwright/import-dialog.spec.ts` - Ctrl+I tests need updating for context-aware behavior (home vs project)
- `e2e-playwright/dmp-import.spec.ts` - Import trigger tests need updating
- `e2e-playwright/keyboard-shortcuts.spec.ts` - Ctrl+I shortcut tests need updating for two-step flow (if exists)

### WebdriverIO Tests
- `e2e/specs/import-dmp-dialog.spec.ts` - Import triggering tests need updating
- `e2e/specs/keyboard-shortcuts.spec.ts` - Ctrl+I tests need updating for new flow
- `e2e/specs/drag-drop.spec.ts` - Drag-drop DMP tests need updating (if exists)

### Mock Updates
- `e2e-playwright/mocks/tauri-ipc.ts` - Add mock handlers for `calculateFileHash`, `checkDuplicateImport` if not present

## Test Suggestions

### Unit Tests (Rust)
1. Test file hash calculation

### Playwright Tests (3-10)
1. Test Ctrl+I opens file picker (mock)
2. Test import from home screen shows project dialog
3. Test import from existing project opens Step 1
4. Test duplicate file shows warning
5. Test drag-drop triggers import flow (mock)

### WebdriverIO Tests (3-10)
1. Test full Ctrl+I flow from home screen
2. Test full Ctrl+I flow from existing project
3. Test drag-drop DMP file
4. Test duplicate import warning
5. Test completing import adds sections to project

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
