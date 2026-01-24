# fn-21-q0u.6 Add ARIA live announcements for selection changes

<!-- Updated by plan-sync: fn-21-q0u.4 - ARIA infrastructure already exists, this task just needs verification -->

## Description
Verify ARIA live region announces selection changes when hyperlinks are clicked.

**Size:** XS (verification only - infrastructure already implemented)
**Files:** No changes needed - verify existing implementation

## Existing Implementation (already done)

### Live Region - EXISTS in App.tsx
The live region already exists at app root level in `src/App.tsx:585-592`:
```tsx
<div
  id="selection-announcer"
  role="status"
  aria-live="polite"
  aria-atomic="true"
  className="sr-only"
>
  {selectionAnnouncement}
</div>
```

### Store State - EXISTS in uiStore.ts
- `selectionAnnouncement: string` state at line 247
- `announceSelection: (message: string) => void` action at line 248

### DetailLink Integration - ALREADY WIRED
- DetailLink accepts `onAnnounce` callback prop (implemented in fn-21-q0u.2)
- StationDetail passes `onAnnounce={announceSelection}` to all DetailLink components
- ShotDetail passes `onAnnounce={announceSelection}` to all DetailLink components
- DetailLink calls `onAnnounce` with format: `Selected {type} {displayText}`

## Approach (verification only)

1. Verify live region exists in App.tsx
2. Verify announceSelection is called when DetailLinks are clicked
3. Test screen reader announces selections (manual test with NVDA/VoiceOver)

## Acceptance
- [x] Visually hidden live region exists in App.tsx (at app root, always mounted)
- [x] Selection changes from hyperlink clicks are announced via `announceSelection`
- [x] Selection changes from map/panel clicks are NOT announced (DetailLink triggers, not setSelection)
- [x] Announcement format: "Selected {type} {displayText}" (e.g., "Selected station 1:3")
- [x] Uses `aria-live="polite"` for non-urgent updates
- [x] Live region always mounted (in App.tsx, not conditionally rendered)
- [x] DetailLink accepts `onAnnounce` callback prop
- [ ] **Verification:** Manually test with screen reader (NVDA/VoiceOver) that announcements work

## Done summary
Verified ARIA live announcements code infrastructure is correctly implemented. Live region exists in App.tsx with role="status" and aria-live="polite". DetailLink component calls onAnnounce with format "Selected {type} {displayText}" when clicked. All detail views pass announceSelection callback to DetailLink components. Note: Manual screen reader verification (NVDA/VoiceOver) is pending and will be performed separately.

## Evidence
- Commits:
- Tests: pnpm tsc --noEmit, pnpm test:ui (471 passed)
- PRs:
