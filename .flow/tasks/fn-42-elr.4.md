# fn-42-elr.4 Refactor hardcoded Import/Export handlers to use configurable shortcuts

## Description
Refactor the hardcoded Ctrl+I (import) and Ctrl+E (export) handlers in useKeyboardShortcuts.ts to use the configurable shortcut system instead.

**Size:** M
**Files:**
- `src/hooks/useKeyboardShortcuts.ts`

## Approach
- Remove hardcoded Ctrl+I handler (lines 351-407) that calls `importDmp()`
- Remove hardcoded Ctrl+E handler (lines 409-416) that calls `openDialog('export')`
- Add `import_dmp` and `export` to the actions array in `buildShortcutMap()` (lines 136-165)
- Create handler functions that call `importDmp()` and `openDialog('export')` respectively
- Follow pattern of other configurable actions like `toggle_sections_panel`

## Key context
- Hardcoded handlers currently check `isCtrlOrCmd && event.key.toLowerCase() === 'i'` directly
- After refactor, shortcuts will be looked up from `config.shortcuts.import_dmp` and `config.shortcuts.export`
- Must guard against activeElement focus (see memory entry about contentEditable/input/textarea)
- `importDmp` function is available from context at line 253 (useProjectStore destructure)
- `openDialog` function is available from context at line 246 (useUIStore destructure)
<!-- Updated by plan-sync: fn-42-elr.3 shifted line numbers in useKeyboardShortcuts.ts; Ctrl+I handler spans lines 351-407, Ctrl+E handler spans lines 409-416, importDmp at line 253, openDialog at line 246 -->
## Acceptance
- [ ] Hardcoded Ctrl+I handler removed from useKeyboardShortcuts.ts
- [ ] Hardcoded Ctrl+E handler removed from useKeyboardShortcuts.ts
- [ ] `import_dmp` action added to buildShortcutMap() with handler calling importDmp()
- [ ] `export` action added to buildShortcutMap() with handler calling openDialog('export')
- [ ] Pressing configured shortcut (default Ctrl+I) opens import dialog
- [ ] Pressing configured shortcut (default Ctrl+E) opens export dialog
- [ ] Custom shortcuts (user-configured) trigger correct actions
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
