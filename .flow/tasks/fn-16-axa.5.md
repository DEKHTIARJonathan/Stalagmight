# fn-16-axa.5 Refactor SettingsDialog to sidebar layout with dirty tracking

## Description
Refactor the main SettingsDialog component to use the new sidebar layout, integrate all category content components, implement field-level dirty tracking, and add Reset to Defaults functionality.

**Size:** L
**Depends on:** fn-16-axa.3 (Sidebar), fn-16-axa.4 (Category content)
**Files:**
- `src/components/Dialogs/SettingsDialog.tsx` - Major refactor

## Approach

1. Replace horizontal tabs with SettingsSidebar + content area layout
2. Dialog structure:
   - Fixed size: min-width 600px, min-height 500px (use DialogWrapper size="4xl" or custom)
   - Sidebar on left (~150px fixed)
   - Content area on right with independent scrolling
   - Footer with Save (disabled when no changes), Cancel, full-width
3. State management:
   - Track changes per-field using useReducer or object diff
   - `changedFields: Set<string>` to track which fields have been modified
   - Derive `isDirty` from changedFields.size > 0
   - Derive `categoryErrors` from validation (shortcut conflicts, invalid numbers)
4. Preserve unsaved changes when switching categories (don't reset localConfig)
5. Reset to Defaults:
   - Per-category button in content header area
   - Confirmation dialog before reset
   - Reset only current category's fields from defaultConfig
6. Close behavior:
   - X button with unsaved changes: show "Discard unsaved changes?" confirmation with Save/Discard/Cancel
   - DialogWrapper already has isDirty confirmation - leverage it
7. Prevent click-outside close (DialogWrapper handles this)

## Key Context

- Current SettingsDialog.tsx at `src/components/Dialogs/SettingsDialog.tsx` has ~1060 lines
- DialogWrapper at `src/components/Dialogs/DialogWrapper.tsx:1-131` handles close confirmation
- Existing `computeConfigDiff()` function can be adapted for field-level tracking
- Default config at `src/types/config.ts` exports `defaultConfig`
- Memory pitfall: "Per-project settings need in-memory cache for new unsaved projects"

## Acceptance
- [ ] Dialog has sidebar on left, content area on right
- [ ] Fixed minimum size 600px × 500px
- [ ] Content area scrolls independently, sidebar stays fixed
- [ ] Category title displayed as header in content area
- [ ] Reset to Defaults button in category header with confirmation
- [ ] Save button disabled when no changes
- [ ] Changed fields tracked per-field (for highlighting)
- [ ] Unsaved changes preserved when switching categories
- [ ] X button shows confirmation when dirty (Save/Discard/Cancel)
- [ ] Category error indicators passed to sidebar (red dots)
- [ ] Footer has Save and Cancel buttons, full-width
- [ ] Opens to General category by default
- [ ] All existing functionality preserved (save, reload config)
- [ ] pnpm tsc --noEmit passes
