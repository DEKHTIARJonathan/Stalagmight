# fn-51-ctu.11 Implement Import State Management with Undo/Redo

## Description
Implement state management for import flow with per-section tracking, undo/redo, and granular backend entries.

## Files to Create
- `src/hooks/useImportState.ts`

## Files to Modify
- `src/components/Dialogs/DmpSectionConfigDialog.tsx`
- `src/store/projectStore.ts`

## State Structure
```tsx
interface ImportState {
  sectionConfigs: Map<number, SectionConfig>;
  currentSection: number;
  placedSections: Set<number>;
  undoStacks: Map<number, UndoEntry[]>;
  redoStacks: Map<number, UndoEntry[]>;
}
```

## Undo/Redo
- Per-section undo stacks
- Entry types: shotEdit, shotAdd, shotDelete, metadataEdit, placementChange
- Backend creates granular undo entries after placement

## References
- `tasks/urgent/task-11-import-state-management.md`
## Acceptance
- [ ] useImportState hook created with all actions
- [ ] Per-section state tracking works
- [ ] Undo reverses last edit for current section
- [ ] Redo re-applies undone change
- [ ] Undo/redo stacks preserved when navigating
- [ ] Backend creates granular undo entries after placement
- [ ] Reset Section restores original DMP data
- [ ] Reset Section deletes placed section from backend
- [ ] TypeScript compiles without errors
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
