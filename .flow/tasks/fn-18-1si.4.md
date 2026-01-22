# fn-18-1si.4 Update documentation for stats feature

## Description
Update project documentation to reflect the new statistics footer feature in DMP import dialogs.

**Size:** S
**Files:** `docs/SPEC.md`, `docs/TESTING.md`

## Approach

1. Update `docs/SPEC.md` Section 6.6 (DMP Import Dialogs):
   - Update Step 1 section (lines ~481-503) with selection stats in mockup
   - Update Step 2 section (lines ~512-577) with section stats in Parameters panel
   - Document formatting rules, unit conversion, edge cases

2. Update `docs/TESTING.md`:
   - Add test IDs to conventions table (line ~530)
   - Add ARIA label documentation (lines ~1488-1495)
   - Update dialog reference table (lines ~254-262)

## Key context

Test IDs to document:
- Step 1: `selection-stats`, `stats-shot-count`, `stats-total-length`, `stats-depth-range`
- Step 2: `section-stats`, `section-stats-shot-count`, `section-stats-total-length`, `section-stats-depth-range`

ARIA label pattern:
```
aria-label="Section statistics: 5 shots, 42.3 meters total length, depth range 2.1 to 15.4 meters"
```
## Acceptance
- [ ] SPEC.md Step 1 section updated with selection stats description
- [ ] SPEC.md Step 2 section updated with section stats in Parameters panel
- [ ] SPEC.md documents formatting rules (precision, separators, units)
- [ ] SPEC.md documents edge cases (empty selection, no depth data)
- [ ] TESTING.md test ID table includes all new stats test IDs
- [ ] TESTING.md ARIA requirements section updated
- [ ] Documentation follows existing format/style conventions
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
