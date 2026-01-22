# fn-17-ygu.4 Update export documentation

## Description
Update documentation to reflect the fixed export scaling behavior.

**Size:** S
**Files:**
- `docs/SPEC.md` (section 17.3 - Export Formats)
- `docs/TESTING.md` (export testing section)
- `src-tauri/src/export/image.rs` (code comments)

## Approach

1. Update SPEC.md section 17.3 with DPI scaling behavior and element size specs
2. Add "Export Testing" subsection to TESTING.md
3. Add code comments explaining scale calculation in image.rs

## Key context

- Document formula: `viewBox_size = pixel_size / scale`
- Element sizes: station 4px, shot stroke 2px, grid 0.5px, labels 8-12px
## Acceptance
- [ ] SPEC.md section 17.3 updated with scaling details
- [ ] Element size specifications documented
- [ ] TESTING.md has export testing section
- [ ] Code comments explain scaling logic
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
