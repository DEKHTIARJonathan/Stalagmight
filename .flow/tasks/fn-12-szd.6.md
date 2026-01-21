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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
