# Shortcuts Settings Panel Improvements

## Overview
Improve the Shortcuts settings panel UX with 4 changes:
1. Make Ctrl+I (Import DMP) and Ctrl+E (Export) user-configurable instead of reserved
2. Widen shortcut name column using flex-grow to fill available space
3. Condense rows ~40% with theme-aware alternating colors (reset per category)
4. Move reserved shortcuts section above search bar

## Scope
- Frontend: ShortcutsSettings.tsx, shortcuts.ts, useKeyboardShortcuts.ts, config types
- Backend: Rust config types and defaults (sync with frontend)
- Tests: E2E tests and visual regression baselines
- Docs: configuration.md, SPEC.md

## Approach

### Making Ctrl+I/E Configurable
1. Remove from `RESERVED_SHORTCUTS`, `RESERVED_CTRL_KEYS`, `RESERVED_CTRL_DESCRIPTIONS` in shortcuts.ts
2. Add new "File" category (first position) with `import_dmp` and `export` actions
3. Add types to ShortcutsConfig (TypeScript + Rust)
4. Refactor hardcoded handlers in useKeyboardShortcuts.ts to use configurable flow via buildShortcutMap()
5. Keep Ctrl+I/E as defaults, standard reset behavior

### UI Layout Changes
- Name column: Replace `w-32` with `flex-1 min-w-32 truncate` + tooltip
- Row condensing: Reduce `space-y-2` to `space-y-0.5`, `py-1` to `py-0.5`
- Alternating colors: Use `odd:bg-muted/30 even:bg-transparent dark:odd:bg-muted/20` with index reset per category
- Reserved section: Move JSX block (lines 316-332) above search bar (lines 278-302)

## Quick commands
```bash
# Type check
pnpm tsc --noEmit

# Run shortcut-related E2E tests
pnpm test:ui -- --grep "shortcuts"

# Run all tests
pnpm test:ui
cargo test --manifest-path src-tauri/Cargo.toml
```

## Risks / Dependencies
- **fn-41-glr overlap**: Both touch SettingsDialog area - coordinate or complete fn-41 first
- **Rust sync required**: TypeScript and Rust config types must match exactly
- **Test updates**: Removing Ctrl+I/E from reserved breaks existing unit tests

## Acceptance
- [ ] Ctrl+I and Ctrl+E can be assigned to any action
- [ ] Import DMP and Export appear in File category as configurable shortcuts
- [ ] Default shortcuts for Import DMP (Ctrl+I) and Export (Ctrl+E) work out of box
- [ ] Shortcut name column expands to fill available space using flex-grow
- [ ] Long names truncate with ellipsis and show tooltip on hover
- [ ] Row vertical spacing reduced ~40% compared to current
- [ ] Alternating row colors use theme-aware tokens (muted/background)
- [ ] Alternation resets at each category boundary
- [ ] Reserved shortcuts section appears above search bar
- [ ] Reserved section always visible, not filtered by search
- [ ] E2E tests updated for new behavior
- [ ] Visual regression test baselines updated
- [ ] Works correctly in both light and dark themes
- [ ] Docs updated (configuration.md, SPEC.md)

## References
- `src/utils/shortcuts.ts:22-30` - RESERVED_SHORTCUTS set
- `src/utils/shortcuts.ts:340-356` - RESERVED_CTRL_KEYS and descriptions
- `src/hooks/useKeyboardShortcuts.ts:351-407` - Hardcoded Ctrl+I/E handlers
- `src/components/Dialogs/settings/ShortcutsSettings.tsx:27-58` - SHORTCUT_CATEGORIES
- `src/components/Dialogs/settings/ShortcutsSettings.tsx:316-332` - Reserved section
- `src/components/Dialogs/settings/ShortcutsSettings.tsx:278-302` - Search bar
- `src/types/config.ts:184-216` - ShortcutsConfig interface
- `src-tauri/src/config/types.rs` - Rust ShortcutsConfig
- `src-tauri/src/config/defaults.rs:157-196` - Rust defaults
