# Task 43: Screen Reader Announcements

## Overview
Add ARIA live regions for status updates, tool changes, and selection changes. Ensure screen reader users are informed of application state changes.

## Priority
Medium-High - Phase D (Accessibility)

## Risk Level
Medium-High

## Dependencies
- Task 42: Focus management

## Files to Modify
- `src/components/common/LiveRegion.tsx` - New component
- `src/components/StatusBar.tsx` - Announce status changes
- `src/store/uiStore.ts` - Track announcements
- `src/hooks/useAnnounce.ts` - New hook

## Specifications

### Live Region Component
```tsx
<LiveRegion
  politeness="polite"  // or "assertive"
  clearAfter={5000}    // ms, optional
/>
```

### Announcement Events
Configurable set of events to announce:
- Tool selection changes
- Station selection changes
- Save status (saved, saving, error)
- Validation results
- Dialog open/close
- Error messages

### Politeness Levels
- `polite`: Non-urgent updates (tool changes, selections)
- `assertive`: Important updates (errors, save failures)

### Configurable Announcements
- User can enable/disable announcement categories
- Settings in accessibility preferences
- Default: all enabled

### Status Bar Integration
- Status bar changes trigger announcements
- Debounce rapid changes (100ms)
- Don't announce every keystroke

### Implementation Pattern
```tsx
// In component
const announce = useAnnounce();
announce("Station A5 selected", "polite");

// LiveRegion renders to screen reader only
<div aria-live="polite" className="sr-only">
  {currentAnnouncement}
</div>
```

### Screen Reader Only Class
```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

## Acceptance Criteria
- [ ] LiveRegion component works
- [ ] Tool changes announced
- [ ] Selection changes announced
- [ ] Save status announced
- [ ] Error messages announced
- [ ] Announcements configurable
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Playwright Tests (Mocked IPC)
1. Test LiveRegion component renders with aria-live
2. Test tool change triggers announcement
3. Test selection change triggers announcement
4. Test save status triggers announcement
5. Test error messages announced assertively
6. Test announcements debounced (100ms)
7. Test announcement categories configurable
8. Test disabled category not announced

### WebdriverIO Tests (Full App)
1. Test screen reader receives announcements (via ARIA inspection)
2. Test announcement timing with real operations
3. Test announcement preferences persist
4. Test rapid changes properly debounced
5. Test announcements during dialog interactions

## Edge Cases
- Rapid consecutive announcements
- Very long announcement text
- Announcement during dialog
- Multiple simultaneous events
