# Fix Settings Dialog Scroll - Main Panel Only

## Overview

The Settings dialog main panel is not scrollable. While content can be scrolled via keyboard Tab navigation, this incorrectly scrolls the entire dialog including the sidebar and bottom Save/Cancel row. Only the main content panel should scroll while sidebar and footer remain static.

**Root cause**: The scrollable content div at `SettingsDialog.tsx:576` is missing `min-h-0` class, which is required for nested flexbox scrolling to work properly.

## Scope

- Fix main content panel scroll behavior
- Add independent scroll capability to sidebar (future-proofing)
- No changes to footer styling
- No auditing of other dialogs

## Approach

1. Add `min-h-0` to main content scrollable div (line 576)
2. Add `overflow-auto min-h-0` to sidebar for independent scroll capability
3. Follow pattern from `DmpSectionConfigDialog.tsx` (lines 1037, 1124, 1126)

## Key Decisions

- **Scrollbar visibility**: Only show when content overflows (overflow-auto)
- **Sidebar**: Add independent scroll capability now for future-proofing
- **Footer**: Keep current styling
- **Tab navigation**: Should auto-scroll main panel only
- **Scroll position**: Resets to top when switching panels (existing behavior)

## Quick commands

```bash
# Run Playwright tests
pnpm test:ui

# Type check
pnpm tsc --noEmit

# Dev server (to manually verify)
./scripts/dev.sh
```

## Risks

- Low risk: Simple CSS class addition following established pattern
- The `min-h-0` pattern is already used successfully in `DmpSectionConfigDialog.tsx`

## Test Notes

- Existing tests in `settings-dialog.spec.ts` verify scroll reset behavior
- Manual verification: open Settings, scroll General panel, verify sidebar/footer stay static

## Acceptance

- [ ] Main content panel scrolls independently with visible scrollbar when content overflows
- [ ] Sidebar remains static (with capability to scroll independently if content grows)
- [ ] Save/Cancel footer remains static at bottom
- [ ] Tab navigation auto-scrolls only the main panel, not the whole dialog
- [ ] Custom scrollbar styling applies to scrollable areas
- [ ] Scroll position resets to top when switching between settings panels
- [ ] Existing Playwright tests pass

## References

- Working pattern: `src/components/Dialogs/DmpSectionConfigDialog.tsx:1037,1124,1126`
- Target file: `src/components/Dialogs/SettingsDialog.tsx:576`
- Sidebar: `src/components/Dialogs/SettingsSidebar.tsx:178`
- Scrollbar styles: `src/index.css:18-35`
- Tests: `e2e-playwright/settings-dialog.spec.ts`
