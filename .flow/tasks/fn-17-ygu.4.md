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

- fn-17-ygu.1 implemented the scaling formula: `viewBox_size = pixel_size / scale`
- All elements already use this formula via px() helper (line 263)
- Actual implemented sizes: station 3px (6px ZD), shot stroke 2px, grid 0.5px, labels 8px/10px/12px
- DPI options: 72, 150, 300, 600
- Code comments already present at lines 261-263, 628-629

## Acceptance

- [ ] SPEC.md section 17.3 updated with scaling details
- [ ] Element size specifications documented (3px/6px station, 2px shot, 0.5px grid)
- [ ] TESTING.md has export testing section
- [ ] Code comments explain scaling logic

## Done summary
Updated export documentation with DPI scaling behavior and element size specifications in SPEC.md section 17.3, added Export Testing section to TESTING.md with test patterns and commands, and enhanced code comments in image.rs explaining the px() helper function.
## Evidence
- Commits: d3629d25c9715d77aa26bdaebe6c6542a968e918
- Tests: pnpm tsc --noEmit, cargo test --manifest-path src-tauri/Cargo.toml export
- PRs: