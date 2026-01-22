# fn-15-ygz.11 Update documentation for Global View changes

## Description

Update documentation to reflect all Global View changes.

**Size:** S
**Files:**
- `docs/SPEC.md` (sections 6.1.1, 6.3, 6.4, 13.2, Appendix A)
- `docs/architecture.md` (key files, state flow)
- `docs/configuration.md` (new config options, shortcuts)
- `docs/TESTING.md` (test patterns for new features)
- `docs/project-structure.md` (new files)

## Approach

- Update SPEC.md section 6.1.1 with survey rendering details
- Add new keyboard shortcuts to Appendix A
- Document config options in configuration.md:
  - `global_view.fps_threshold` (default 30)
  - `global_view.tolerance` (default 0.5)
  - `global_view.throttle_tolerance` (default 1.0)
- Add test patterns for GlobalView features
- Update architecture with new files and data flow
- Follow existing documentation format and style

## Acceptance

- [ ] SPEC.md section 6.1.1 updated with survey rendering behavior
- [ ] Keyboard shortcuts documented in SPEC.md Appendix A
- [ ] Config options documented: fps_threshold, tolerance, throttle_tolerance
- [ ] Test patterns added to TESTING.md
- [ ] Architecture.md updated with new files
- [ ] project-structure.md reflects new components

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
