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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
