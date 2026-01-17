# Add per-section adjustment dialog

## Overview
Dialog for dx/dy offset adjustment. Live preview, undo support.

## Scope
- Context menu in SectionsPanel
- dx/dy inputs (relative)
- Live preview on map
- Undo support (Ctrl+Z)
- Merged groups move together

## Quick commands
```bash
pnpm tsc --noEmit && pnpm test:ui
```

## Acceptance
- [ ] Context menu item
- [ ] Dialog opens
- [ ] dx/dy inputs work
- [ ] Live preview
- [ ] Undo reverts
- [ ] Tests pass

## References
- Task spec: `./tasks/task-13-section-adjustment-dialog.md`
