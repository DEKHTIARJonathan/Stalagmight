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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
