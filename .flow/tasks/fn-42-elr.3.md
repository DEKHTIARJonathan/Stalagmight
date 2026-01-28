# fn-42-elr.3 Add File category with Import DMP and Export shortcuts

## Description
Add a new "File" category to SHORTCUT_CATEGORIES containing `import_dmp` and `export` actions, making them appear in the shortcuts settings UI as configurable.

**Size:** S
**Files:**
- `src/components/Dialogs/settings/ShortcutsSettings.tsx`

## Approach
- Add new category object to SHORTCUT_CATEGORIES array (lines 27-58)
- Place "File" as FIRST category (before "Tools") since file operations are fundamental
- Category structure: `{ id: 'file', label: 'File', actions: ['import_dmp', 'export'] }`
- Actions will automatically render using existing category rendering logic

## Key context
- SHORTCUT_CATEGORIES controls what appears in the shortcuts settings UI
- Action names must match the fields in ShortcutsConfig type (task fn-42-elr.1)
- formatActionName() in shortcuts.ts will convert snake_case to "Import Dmp" and "Export"
## Acceptance
- [ ] "File" category added as first item in SHORTCUT_CATEGORIES
- [ ] Category contains `import_dmp` and `export` actions
- [ ] File category appears first in shortcuts settings UI
- [ ] Import DMP and Export shortcuts are recordable/configurable
- [ ] Reset button works for Import DMP and Export
## Done summary
Added "File" category as the first item in SHORTCUT_CATEGORIES with import_dmp and export actions, making Import DMP and Export shortcuts configurable in the settings UI. Also removed Ctrl+I and Ctrl+E from RESERVED_SHORTCUT_DESCRIPTIONS since they are now user-configurable.
## Evidence
- Commits: b9676f740a6852285c803fbf75e5fe26f8321d69
- Tests: pnpm tsc --noEmit, cargo test --manifest-path src-tauri/Cargo.toml, pnpm test:ui -- --grep shortcuts
- PRs: