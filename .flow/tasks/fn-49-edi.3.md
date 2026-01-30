# fn-49-edi.3 Render warning badges and yellow status icons in section list

## Description

Update the section list sidebar in `DmpSectionConfigDialog` to show yellow warning count badges and yellow status icons when a section has warnings but no errors.

### Implementation

<!-- Updated by plan-sync: fn-49-edi.2 map() moved to ~line 1044 -->
- In the section list `map()` (~line 1044), compute `sectionWarnings` using `getSectionWarningCount(sectionIdx, validationConfig)`. Note: `getSectionWarningCount` must be destructured from `importState` (it is not currently destructured in the component's destructuring block at ~line 104).
- Determine whether to show warnings based on visibility rules:
  ```typescript
  const showWarnings = sectionWarnings > 0
    && sectionDataErrors === 0
    && status !== 'excluded'
    && status !== 'placed';
  ```
- Update the status icon logic to add a warnings state between errors and placed:
  ```typescript
  if (status === 'excluded') {
    statusIcon = '✕'; statusColor = 'text-error';
  } else if (status === 'errors' || sectionDataErrors > 0) {
    statusIcon = '!'; statusColor = 'text-error';
  } else if (showWarnings) {
    statusIcon = '⚠'; statusColor = 'text-warning';
  } else if (status === 'placed') {
    statusIcon = '✓'; statusColor = 'text-success';
  } else {
    statusIcon = '○'; statusColor = 'text-text-secondary';
  }
  ```
- Add a yellow warning badge (only when `showWarnings` is true):
  ```tsx
  {showWarnings && (
    <span
      className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 bg-warning text-black rounded-full text-[10px] font-medium"
      data-testid={`section-warning-count-${arrayIdx}`}
      title={`${sectionWarnings} warning${sectionWarnings > 1 ? 's' : ''}`}
    >
      {sectionWarnings}
    </span>
  )}
  ```
- **Badge visibility rules**:
  - Suppress warning badge when section has errors (error badge takes precedence)
  - Suppress warning badge on placed sections (data committed)
  - Suppress warning badge on excluded sections (won't be imported)
  - Show warning badge only on unplaced sections with no errors
- Error summary text at bottom of sidebar stays unchanged (errors only).

### Depends on
- fn-49-edi.1 (validation config available in component)
- fn-49-edi.2 (getSectionWarningCount function available)

### Files changed
- `src/components/Dialogs/DmpSectionConfigDialog.tsx`

## Acceptance
- [ ] Yellow warning badge shown on unplaced section list items with azimuth/pitch discrepancies and no errors
- [ ] Section status icon is yellow ⚠ when warnings exist but no errors, not placed/excluded
- [ ] Warning badge suppressed when errors exist
- [ ] Warning badge suppressed on placed sections
- [ ] Warning badge suppressed on excluded sections
- [ ] Status priority: excluded > errors > warnings > placed > default
- [ ] Error summary at bottom unchanged (errors only)
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm test:ui` passes

## Done summary
Rendered yellow warning badges and status icons in the DMP import section list sidebar. Sections with azimuth/pitch discrepancies (but no errors) now show a yellow warning icon and count badge. Warning display is suppressed for placed, excluded, and error sections. Updated E2E tests to account for the new warning state.
## Evidence
- Commits: 4da1affa9af2e7f9c3dbc3fb1d3e6b22e5c99fe2, 97605172a6846f9994dd7763661d2f551d15b969
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: