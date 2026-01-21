# fn-12-szd.6 Add Zoom to Section context menu item

## Description
Add "Zoom to Section" item to the section context menu.

**Size:** S
**Files:** `src/components/common/ContextMenu.tsx`

## Approach

- Find section menu items at `src/components/common/ContextMenu.tsx:166-188`
- Add "Zoom to Section" item before "Delete Section"
- Item calls `triggerZoomToSection(sectionId)` and closes the menu
- Icon: use a zoom/focus icon (e.g., `ZoomIn` or `Focus` from lucide-react)

## Key context

- Context menu receives `dialogData.target` with `{ type: 'section', sectionId }`
- Menu items are React components with onClick handlers
## Acceptance
- [ ] "Zoom to Section" menu item added to section context menu
- [ ] Item appears before "Delete Section"
- [ ] Click triggers zoom to section
- [ ] Menu closes after click
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Added "Zoom to Section" context menu item to section context menu. The item appears after "Adjust Position..." and before the separator/Delete Section, triggers zoom action via triggerZoomToSection, and closes the menu after click.
## Evidence
- Commits: 1baaa9e3dd8a3c23c5f9150dcb8a0b5a586f7317
- Tests: pnpm tsc --noEmit
- PRs: