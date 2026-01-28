# fn-45-n3z.3 Implement zero datum merge validation logic

## Description

Implement new merge validation logic: check zero datum connectivity first, then loop detection. Set `can_merge` and `reason` fields in ConnectivityResult response. Update frontend to check `can_merge` (not `connected`) and handle merge-to-closure redirect with reason subtitle.

**Size:** M
**Files:**
- `src-tauri/src/commands/station.rs` (validation logic)
- `src/hooks/useMapTools.ts` (merge flow - check can_merge)
- `src/components/Dialogs/ClosureDialog.tsx` (reason subtitle)
- `src-tauri/src/models/project/tests.rs` (validation tests)

## Approach

<!-- Updated by plan-sync: fn-45-n3z.1 changed check_merge_connectivity_impl structure and line references -->

1. Update merge connectivity validation logic:
   - `check_merge_connectivity_impl()` in `commands/station.rs:16-22` currently delegates to `state.check_merge_connectivity()` -- the validation logic lives in the state layer, not in this thin wrapper
   - Set `can_merge` and `reason` fields on `ConnectivityResult` (types added in task 1, with `#[serde(default)]` on both fields)
   - New validation flow:
     1. Check if both sections connected to zero datum → `can_merge: false, reason: Some("Both sections have fixed coordinates".into())`
     2. Check if only one has zero datum → `can_merge: true, reason: None`
     3. Neither has zero datum → check loop existence:
        - Loop exists → `can_merge: false, reason: Some("Creates survey loop".into())`
        - No loop → `can_merge: true, reason: None`
   - Keep `connected` field for backward compatibility

2. Add helper `is_section_connected_to_zero_datum()` in `project.rs`:
   - BFS from section through merges/closures
   - Return true if any reachable station has `is_zero_datum=true`

3. Update `useMapTools.ts` merge flow (lines 87-134):
   - Check `result.can_merge` (not `result.connected`) to decide dialog
   - When `can_merge: false`, pass `result.reason` to ClosureDialog
   - Silent redirect (no intermediate confirmation)

4. Update `ClosureDialog.tsx`:
   - Add optional `reason?: string` prop
   - Render as subtitle below "Create Loop Closure" title when present
   - Style: `text-sm text-text-secondary`

5. Add Rust tests:
   - Both sections have zero datum → can_merge=false
   - Only one section has zero datum → can_merge=true
   - Neither has zero datum, loop exists → can_merge=false
   - Neither has zero datum, no loop → can_merge=true

## Key Context

- Existing `check_merge_connectivity_impl` at `commands/station.rs:16-22` (thin wrapper, delegates to `state.check_merge_connectivity()`)
- Zero datum check uses connected sections (includes merges AND closures now)
- Loop detection reuses `get_connected_section_ids()` which now includes closures
- ClosureDialog at `src/components/Dialogs/ClosureDialog.tsx`
- ConnectivityResult type updated in task 1 with `can_merge: bool` and `reason: Option<String>` fields (both have `#[serde(default)]`)
- `ConnectivityResult` also has existing `connected: bool` and `preview: Option<ClosurePreview>` fields (station.rs:306-315)

## Acceptance

- [ ] check_merge_connectivity sets `can_merge: bool` and `reason: Option<String>`
- [ ] Both sections connected to zero datum → can_merge=false, reason="Both sections have fixed coordinates"
- [ ] Only one section has zero datum → can_merge=true
- [ ] Neither has zero datum + loop exists → can_merge=false, reason="Creates survey loop"
- [ ] Neither has zero datum + no loop → can_merge=true
- [ ] ClosureDialog accepts optional `reason` prop
- [ ] Reason displays as subtitle below dialog title
- [ ] useMapTools checks `can_merge` (not `connected`) for dialog routing
- [ ] Frontend silently redirects merge to closure when can_merge=false
- [ ] Test: zero datum validation determines merge vs closure
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `pnpm tsc --noEmit` passes
