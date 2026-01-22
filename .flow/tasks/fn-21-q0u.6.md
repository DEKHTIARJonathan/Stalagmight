# fn-21-q0u.6 Add ARIA live announcements for selection changes

## Description
Add ARIA live region to announce selection changes when hyperlinks are clicked.

**Size:** S
**Files:** `src/components/SingleSystemView/DetailPanel.tsx`

## Approach

### Live Region - MUST be in DetailPanel, not DetailsContent
Add visually hidden live region at **DetailPanel component root level** (not inside DetailsContent):
```tsx
// In DetailPanel component, at root level
<span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
  {selectionAnnouncement}
</span>
```

**Why DetailPanel not DetailsContent?** DetailsContent may re-mount on selection changes, which would break the "always mounted" requirement. DetailPanel is stable.

Follow existing pattern at `ShortcutRecorder.tsx:325-332`.

### Announcement Logic (Hyperlink-Triggered Only)
Only announce selection changes triggered by DetailLink clicks - NOT map clicks or Sections Panel clicks:
- Add `announcement` state to DetailPanel component
- Pass `onAnnounce` callback down through DetailsContent to DetailLink components
- DetailLink calls `onAnnounce` when clicked (before calling onSelect)
- Live region re-renders with new announcement text

Announcement formats:
- Station: "Selected station {sectionId}:{stationPosition}"
- Shot: "Selected shot {sectionId}:{shotPosition}"
- Section: "Selected section {sectionId}: {sectionName}"

Use `aria-live="polite"` (not "assertive") - selection is non-urgent.
Keep live region always mounted (don't conditionally render).

## Acceptance
- [ ] Visually hidden live region exists at DetailPanel component root (not in DetailsContent)
- [ ] Selection changes from hyperlink clicks are announced
- [ ] Selection changes from map/panel clicks are NOT announced (no duplicate announcements)
- [ ] Announcement format: "Selected {type} {id}"
- [ ] Uses `aria-live="polite"` for non-urgent updates
- [ ] Live region always mounted (not conditionally rendered)
- [ ] DetailLink accepts `onAnnounce` callback prop

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
