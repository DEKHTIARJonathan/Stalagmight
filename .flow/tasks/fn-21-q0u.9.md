# fn-21-q0u.9 Update documentation

## Description
Update project documentation to reflect the new Detail Panel hyperlinks and center button features.

**Size:** S
**Files:** `docs/SPEC.md`, `docs/TESTING.md`

## Approach

### SPEC.md Updates
Add to Section 6 (User Interface):
- Detail Panel hyperlink behavior
- ID format standard: `sectionId:position` (1-indexed)
- "Connected" and "Endpoints" section layouts
- Center button behavior

### TESTING.md Updates
Add to Section "Test Identifiers":
- New data-testid conventions for detail links
- Center button test IDs
- ARIA live region testing approach

Add accessibility testing notes:
- aria-label patterns for detail links
- Live region announcement testing
## Acceptance
- [ ] SPEC.md Section 6 includes Detail Panel hyperlink specification
- [ ] SPEC.md documents ID format standard (sectionId:position, 1-indexed)
- [ ] TESTING.md includes data-testid patterns for links and center buttons
- [ ] TESTING.md includes accessibility testing guidance for live regions
## Done summary
Updated SPEC.md with Detail Panel hyperlinks specification (Section 6.2.1-6.2.3) documenting UI display ID format, Connected/Endpoints sections, center button behavior, and ARIA live announcements. Updated TESTING.md with data-testid patterns for detail links and center buttons, ARIA label patterns, live region testing guidance, and a dedicated Detail Panel testing section.
## Evidence
- Commits: b1e91e1, 33ea36d, dadda88, 5c9628f
- Tests: pnpm tsc --noEmit
- PRs: