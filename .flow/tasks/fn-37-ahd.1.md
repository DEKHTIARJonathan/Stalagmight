# fn-37-ahd.1 Fix warning message format in Rust backend + update unit tests

## Description

Add `section_id: SectionId` parameter to `Validator::validate_shot()` and update all warning message format strings to use "Shot {section_id}:{position}" format. Update all callers (including `commands.rs`) and unit tests.

**Size:** M
**Files:**
- `src-tauri/src/core/validation.rs` — add `section_id` param, update ~12 format strings
- `src-tauri/src/core/state/warnings.rs` — pass `section.id` to `validate_shot()`
- `src-tauri/src/core/state/commands.rs` — update `create_section` and `create_shot` call sites
- `docs/SPEC.md` — update Appendix B validation rules table

## Approach

1. Add `section_id: SectionId` parameter to `validate_shot()` signature at `validation.rs:11`
2. Update all `format!()` calls (lines 22, 31, 40-45, 52-58, 68-75, 82-86, 94-98, 108-116, 124, 134, 144, 154) from `"Shot {} ..."` using `shot_index + 1` to `"Shot {}:{} ..."` using `section_id, shot_index + 1`
3. Update `compute_project_warnings()` at `warnings.rs:62` to pass `section.id` as the new argument
4. Update `commands.rs` call sites:
   - `commands.rs:254` (`create_section`): calls `validate_shot` in a loop over shots. The section is being created here — use `project.next_section_id` (or the section ID computed before validation) so the message references the correct section ID. If validation happens before the section is fully created, compute the ID from the project state beforehand.
   - `commands.rs:329` (`create_shot`): calls `validate_shot` for a new shot — pass the parent section's ID.
5. Verify no other call sites remain — compiler will flag missing args
6. Update all ~30 test invocations in `validation.rs:198-620` to pass a `section_id` argument (use `0` or a meaningful test value)
7. Update test assertions that check exact message text to expect "Shot X:Y" format
8. Update `docs/SPEC.md` Appendix B (around line 2628) validation rules table with new message format examples

## Key context

- `SectionId` is a `u32` type alias at `src-tauri/src/models/section.rs:9`
- Section IDs are 0-indexed; shot display positions are 1-indexed (`shot_index + 1`)
- The secondary line in the warnings tab already uses `formatShotId(warning.section_id, warning.shot_index + 1)` at the frontend — this task aligns the Rust message text with that convention
- Tests use a `default_config()` helper at `validation.rs:176-185`
- `commands.rs:254` validates shots during `create_section` — the section_id may need to be derived from `project.next_section_id` since the section hasn't been inserted yet
- `commands.rs:329` validates a shot during `create_shot` — the parent section's ID is available from the command context

## Acceptance

- [ ] `validate_shot()` signature includes `section_id: SectionId` parameter
- [ ] All ~12 warning message format strings use "Shot {section_id}:{shot_index+1}" format
- [ ] `compute_project_warnings()` passes `section.id` to `validate_shot()`
- [ ] `commands.rs` `create_section` call site passes correct section ID (derived before validation)
- [ ] `commands.rs` `create_shot` call site passes parent section ID
- [ ] No other `validate_shot()` call sites left with old signature (compiler check)
- [ ] All unit tests updated with `section_id` argument and pass
- [ ] Test assertions verify "Shot X:Y" format in message text
- [ ] `docs/SPEC.md` Appendix B table updated with new message format
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `pnpm tsc --noEmit` passes
