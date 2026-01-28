# fn-41-glr.1 Fix main content panel scroll with min-h-0

## Description

Add `min-h-0` class to the Settings dialog main content panel to enable proper flexbox scroll behavior. Also add independent scroll capability to the sidebar for future-proofing.

**Size:** S
**Files:** `src/components/Dialogs/SettingsDialog.tsx`, `src/components/Dialogs/SettingsSidebar.tsx`

## Approach

1. At `SettingsDialog.tsx:576`, change:
   ```tsx
   className="flex-1 overflow-auto p-4"
   ```
   To:
   ```tsx
   className="flex-1 overflow-auto min-h-0 p-4"
   ```

2. At `SettingsSidebar.tsx:178`, add scroll capability:
   - Wrap the category list in a scrollable container with `overflow-auto min-h-0`
   - Keep the outer container with `flex-shrink-0` to maintain fixed width

3. Follow the working pattern from `DmpSectionConfigDialog.tsx:1037,1124,1126`

## Key context

- The `min-h-0` class overrides flexbox default `min-height: auto` which prevents flex items from shrinking below content size
- Without `min-h-0`, `overflow-auto` has no effect because the container expands to fit all content
- The sidebar has 9 static categories that fit in any reasonable dialog height, but adding scroll capability future-proofs the design
## Acceptance
- [ ] Main content div at line 576 has `min-h-0` class added
- [ ] Sidebar has `overflow-auto min-h-0` for independent scroll capability
- [ ] Main panel scrolls with visible scrollbar when content overflows
- [ ] Sidebar remains static while main panel scrolls (unless sidebar content overflows)
- [ ] Save/Cancel footer remains static at bottom
- [ ] Custom scrollbar styling from index.css applies to scrollable areas
- [ ] Tab navigation auto-scrolls only the main panel container
- [ ] Scroll position resets to top when switching settings categories
- [ ] Existing Playwright tests pass: `pnpm test:ui`
## Done summary
Added min-h-0 class to main content panel and sidebar scroll container to enable proper flexbox scroll behavior. Main panel now scrolls independently with visible scrollbar when content overflows, while sidebar and footer remain static.
## Evidence
- Commits: 82c4c75d03ed4209c28d9f3db43e53651bd86cb3
- Tests: pnpm tsc --noEmit, pnpm playwright test e2e-playwright/settings-dialog.spec.ts
- PRs: