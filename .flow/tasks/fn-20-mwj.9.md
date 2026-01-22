# fn-20-mwj.9 Handle deletion edge cases and add ARIA announcements

## Description
Handle deletion edge cases (section/shot deletion) and add ARIA live region announcements for screen reader support.

**Size:** S
**Files:**
- `src/components/SingleSystemView/DataTable.tsx`
- `src/App.tsx` or appropriate root component (ARIA live region)

## Approach

1. **Section deletion handling**:
   - Watch for changes to `sections` array
   - If `selectedSectionId` no longer exists in sections:
     - Auto-switch to first remaining section: `setSelectedSectionId(sections[0]?.id ?? null)`
   - Use useEffect with sections dependency

2. **Shot deletion handling**:
   - Watch for changes to selected section's shots
   - If selected shot no longer exists:
     - Clear selection: `setSelection(null)` or `clearSelection()`
   - Use useEffect with shots + selection dependency

3. **ARIA announcements**:
   - Add live region at app level (keep mounted permanently per best practice):
     ```tsx
     <div id="selection-announcer" role="status" aria-live="polite" aria-atomic="true" className="sr-only" />
     ```
   - When row selection changes, update live region content:
     - "Shot 5:3 selected" (using formatShotId)
   - Use `@react-aria/live-announcer` or manual DOM update

4. **Live region placement**:
   - Add in App.tsx or SingleSystemView.tsx root
   - Use CSS class `sr-only` for visual hiding

## Key context

Memory pitfall: "ARIA live region must exist in DOM before content updates - mount permanently"
Best practice: "Use aria-live='polite' for selection changes (non-urgent)"

CSS sr-only class (typical implementation):
```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}
```
## Acceptance
- [ ] When current section is deleted, DataTable switches to first remaining section
- [ ] When selected shot is deleted, selection is cleared
- [ ] ARIA live region mounted at app root level
- [ ] Selection changes announce to screen readers (e.g., "Shot 5:3 selected")
- [ ] Announcements use polite priority (don't interrupt)
- [ ] Live region stays mounted (not conditionally rendered)
- [ ] Type check passes: `pnpm tsc --noEmit`
- [ ] Playwright tests pass: `pnpm test:ui`
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
