# Task 22: Add export preview thumbnail

## Overview
Add an SVG/image preview to the ExportDialog that shows what the exported map will look like. Preview updates as export options change.

## Priority
Medium - Phase 6 (Export & Polish)

## Risk Level
Medium

## Dependencies
None - can start immediately

## Files to Modify
- `src/components/Dialogs/ExportDialog.tsx` - Add preview panel

## Specifications

### Preview Size
- 300x300 pixels fixed size
- Positioned alongside export options

### Preview Scope
- Map export only (not data export like CSV/JSON)
- Shows what the exported image will look like

### Preview Content
- Match export appearance exactly
- Include all visible layers
- Include annotations if enabled
- Include scale bar if enabled

### Update Behavior
- Debounced updates (e.g., 300ms)
- Show loading state during render
- Update when any option changes

### Theme Toggle
- Toggle in dialog: Light/Dark preview
- Matches export theme setting
- Updates preview immediately

### Preview Toggles
- Show same elements as export settings
- Grid, labels, annotations, etc.
- Toggle changes affect preview

### UI Requirements
- Preview panel with border
- Loading indicator during render
- Add `data-testid` attributes:
  - `export-preview`
  - `export-preview-loading`
  - `export-theme-toggle`

## Acceptance Criteria
- [ ] Preview visible in ExportDialog
- [ ] Preview shows map appearance
- [ ] Preview updates on option changes
- [ ] Updates debounced for performance
- [ ] Theme toggle works
- [ ] Toggle changes affect preview
- [ ] Loading state shown during render
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test preview visible
- Test preview updates on option change
- Test theme toggle changes preview
- Test loading state appears

## Edge Cases
- Very large project (slow render)
- No data to preview (empty project)
- Rapid option changes
- Export dialog resize

## Implementation Notes
- May reuse map rendering components
- Consider canvas vs SVG for preview
- Performance important with large projects
- Preview should match actual export closely
