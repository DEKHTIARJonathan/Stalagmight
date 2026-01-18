# fn-51-ctu.5 Create DmpSectionConfigDialog Shell (Step 2)

## Description
Create Step 2 dialog shell with left panel (section list) and main panel for section configuration.

## Files to Create
- `src/components/Dialogs/DmpSectionConfigDialog.tsx`

## Files to Modify
- `src/components/Dialogs/index.ts`
- `src/App.tsx`

## Dialog Layout (~900x700px fixed)
- Left Panel: Collapsible section list with status icons (✓ placed, ○ not placed, ! errors)
- Main Panel: Preview (250x250) | Parameters | Placement | Shot Table
- Footer: Cancel | Back to Selection | Previous | Next/Import X

## Key Features
- Click section in list to jump directly
- Auto-save current section on navigation
- Keyboard: Ctrl+Enter (proceed), Ctrl+Arrow (navigate), Escape (cancel)

## References
- `tasks/urgent/task-05-dmp-section-config-dialog-shell.md`
## Acceptance
- [ ] Dialog renders with fixed 900x700px size
- [ ] Left panel shows section list with status icons
- [ ] Left panel is collapsible
- [ ] Click section in list navigates to that section
- [ ] Main panel layout with placeholder sections
- [ ] Navigation buttons work (Cancel, Back, Previous, Next)
- [ ] Keyboard shortcuts work
- [ ] TypeScript compiles without errors
## Done summary
## Summary

Created the DmpSectionConfigDialog shell component for Step 2 of the DMP import workflow.

### Key Implementation Details

1. **Dialog Layout (900x700px fixed)**
   - Left panel: Collapsible section list with status icons (✓ placed, ○ not placed, ! errors)
   - Main panel: Section preview (200x200px), parameters form, placement options, shot table
   - Footer: Navigation buttons (Cancel, Back to Selection, Previous, Next/Import X)

2. **Features Implemented**
   - Click section in list to navigate directly
   - Auto-saves current section configuration on navigation
   - Keyboard shortcuts: Ctrl+Enter (proceed), Ctrl+←/→ (navigate), Escape (cancel)
   - Confirmation dialogs for Cancel and Back actions
   - Section status tracking (placed, not placed, errors)
   - First section defaults to "Place at 0,0" placement

3. **Component Integration**
   - Uses existing SectionPreview component for visual preview
   - Uses SectionMetadataForm for editing name, surveyor, date, color, direction
   - Uses ShotTableEditor for viewing/editing shot data
   - Integrated into App.tsx for rendering when `dmp-section-config` dialog is active
   - DmpSelectionDialog (Step 1) now opens DmpSectionConfigDialog (Step 2) on Continue

4. **Placement Options**
   - Place at 0,0 (origin)
   - Zero Datum (GPS coordinates)
   - From Existing Station (disabled when no project/stations)
   - Manual Placement

### Files Changed
- Created: `src/components/Dialogs/DmpSectionConfigDialog.tsx`
- Modified: `src/components/Dialogs/index.ts` (added export)
- Modified: `src/App.tsx` (added dialog rendering)
## Evidence
- Commits:
- Tests: typescript, playwright, rust
- PRs: