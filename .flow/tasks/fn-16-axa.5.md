# fn-16-axa.5 Refactor SettingsDialog to sidebar layout with dirty tracking
<!-- Updated by plan-sync: fn-16-axa.4 added panelIdBase prop and exports types/helpers from ./settings/types and ./SettingsSidebar -->

## Description
Refactor the main SettingsDialog component to use the new sidebar layout, integrate all category content components, implement field-level dirty tracking, add Reset to Defaults functionality, and custom unsaved-changes dialog.

**Size:** L
**Depends on:** fn-16-axa.3 (Sidebar), fn-16-axa.4 (Category content)
**Files:**
- `src/components/Dialogs/SettingsDialog.tsx` - Major refactor
- `src/components/Dialogs/DialogWrapper.tsx` - Add closeOnBackdropClick prop

## Approach

1. **Update DialogWrapper** to support `closeOnBackdropClick?: boolean` prop (default true for backwards compatibility)
2. Replace horizontal tabs with SettingsSidebar + content area layout
3. **Dialog structure** (flex layout):
   - Wrapper: `min-w-[600px] min-h-[500px] overflow-hidden` (content won't scroll wrapper)
   - Sidebar: fixed ~150px width, no scroll
   - Content area: `overflow-auto` for independent scrolling
   - Footer: fixed at bottom, full-width with Save/Cancel
4. **State management**:
   - Track changes per-field using object diff or Set
   - `changedFields: Set<string>` to track which fields have been modified
   - Derive `isDirty` from changedFields.size > 0
   - `categoryErrors: Record<SettingsCategory, boolean>` computed from validation callbacks
   - Generate unique `panelIdBase` using `useId()` for ARIA associations
5. **Validation flow**:
   - Category components call `onValidationError(category, hasError)`
   - SettingsDialog maintains `categoryErrors` state
   - Pass `categoryErrors` to SettingsSidebar for red dot indicators
   - Shortcuts: validate entire binding set on load to detect pre-existing conflicts
6. **Preserve unsaved changes** when switching categories (don't reset localConfig)
7. **Reset to Defaults**:
   - Per-category button in content header area
   - Show ConfirmDialog before reset
   - Reset only current category's fields from defaultConfig
8. **Close behavior - Custom unsaved changes dialog**:
   - X button with unsaved changes: show custom dialog with Save/Discard/Cancel buttons
   - Save: save changes then close
   - Discard: close without saving
   - Cancel: stay in dialog
   - Note: DialogWrapper's built-in dirty confirmation only has Cancel/Discard - we need custom
9. **Backdrop click does NOT close** - pass `closeOnBackdropClick={false}` to DialogWrapper

## Key Context

- Current SettingsDialog.tsx at `src/components/Dialogs/SettingsDialog.tsx` has ~1060 lines
- DialogWrapper at `src/components/Dialogs/DialogWrapper.tsx:1-131` handles close confirmation but only Cancel/Discard
- **Must add `closeOnBackdropClick` prop to DialogWrapper** - backdrop click currently calls requestClose
- Existing `computeConfigDiff()` function can be adapted for field-level tracking
- Default config at `src/types/config.ts` exports `defaultConfig`
- ConfirmDialog at `src/components/Dialogs/ConfirmDialog.tsx` can be used/adapted for reset confirmation
- **Category components** (from fn-16-axa.4) require props: `{ config, onChange, changedFields, onValidationError, panelIdBase }`
  - Import `SettingsCategoryProps` type from `./settings/types`
  - Import `isFieldChanged` helper from `./settings/types`
  - Import `getTabId`, `getPanelId`, `SettingsCategory`, `CATEGORIES` from `./SettingsSidebar`
  - Pass `panelIdBase` prop (from `useId()`) to each category component for ARIA associations

## Acceptance
- [ ] DialogWrapper supports `closeOnBackdropClick` prop (false for Settings)
- [ ] Dialog has sidebar on left, content area on right
- [ ] Fixed minimum size 600px × 500px with flex layout
- [ ] Content area scrolls independently (`overflow-auto`), sidebar and wrapper don't scroll
- [ ] Category title displayed as header in content area
- [ ] Reset to Defaults button in category header with confirmation
- [ ] Save button disabled when no changes
- [ ] Changed fields tracked per-field (for highlighting)
- [ ] Unsaved changes preserved when switching categories
- [ ] **Custom unsaved-changes dialog with Save/Discard/Cancel** (not DialogWrapper's built-in)
- [ ] **Backdrop click does NOT close dialog**
- [ ] Category error indicators computed from validation callbacks
- [ ] categoryErrors passed to sidebar (red dots)
- [ ] Footer has Save and Cancel buttons, full-width
- [ ] Opens to General category by default
- [ ] All existing functionality preserved (save, reload config)
- [ ] pnpm tsc --noEmit passes
