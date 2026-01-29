## Description

Add ability to insert a shot before a specific shot (particularly before the first shot). Currently only `add_shot` (append) and `insert_shot_after` exist in the Section model. Also add `shot_id` field to `CommandResult` so the frontend can select the newly created shot.

## Files to Modify
- `src-tauri/src/models/section.rs` — Add `insert_shot_before` method
- `src-tauri/src/models/project.rs` — Add delegation method
- `src-tauri/src/core/command.rs` — Add `before_shot_id: Option<ShotId>` to `Command::CreateShot` + Add `shot_id: Option<ShotId>` to `CommandResult` + Add constructors
- `src-tauri/src/core/state/commands.rs` — Update `create_shot()` to handle `before_shot_id` and return `shot_id` in result
- `src-tauri/src/commands/shot.rs` — Update `create_shot` Tauri command signature
- `src-tauri/src/core/state/undo.rs` — Ensure undo data handles new insertion position
- `src/types/commands.ts` — Add `shot_id?: number` to `CommandResult` TypeScript type

## Implementation Details

### Section model (`section.rs`)
Add `insert_shot_before` method:
```rust
pub fn insert_shot_before(&mut self, before_id: ShotId, data: ShotData) -> Option<&Shot>
```
Find position of `before_id`, insert new shot at that position, return reference.

### Project model (`project.rs`)
Add delegation:
```rust
pub fn insert_shot_before(&mut self, section_id: SectionId, before_shot_id: ShotId, data: ShotData) -> Option<&Shot>
```

### Command enum (`command.rs`)

#### CreateShot extension
Add `#[serde(default)]` field:
```rust
CreateShot {
    section_id: SectionId,
    shot: ShotData,
    after_shot_id: Option<ShotId>,
    #[serde(default)]
    before_shot_id: Option<ShotId>,
},
```

#### CommandResult extension (IMPORTANT)
Add `shot_id` field:
```rust
pub struct CommandResult {
    pub success: bool,
    pub warnings: Vec<ValidationWarning>,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_id: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub section_ids: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shot_id: Option<u32>,  // NEW
}
```

Add constructors that carry `shot_id`:
- `success_with_shot_id(shot_id: ShotId)` — success with shot_id
- `success_with_shot_id_and_warnings(shot_id: ShotId, warnings: Vec<ValidationWarning>)` — for when validation warnings exist alongside a successful shot creation (e.g., length=0 may trigger a warning)

**CRITICAL**: The existing `create_shot()` in commands.rs returns `success_with_warnings(warnings)` when there are validation warnings. This MUST be changed to return `success_with_shot_id_and_warnings(new_shot_id, warnings)` so the `shot_id` is available even when warnings are present. Without this, the frontend cannot select the new shot after creation with warnings.

Update ALL existing constructors (`success()`, `success_with_warnings()`, `success_with_section_id()`, etc.) to set `shot_id: None` so the new field doesn't break them.

### Command execution (`commands.rs`)
Update `create_shot()`:
- If `before_shot_id` is Some → `project.insert_shot_before(section_id, before_shot_id, data)`
- Else if `after_shot_id` is Some → existing `project.insert_shot_after(...)`
- Else → existing `project.add_shot(...)` (append)
- **Return `shot_id` in the result**: Get the new shot's ID after insertion. Use `success_with_shot_id(new_shot.id)` or `success_with_shot_id_and_warnings(new_shot.id, warnings)` depending on whether warnings were generated.

### Tauri command (`shot.rs`)
Add parameter:
```rust
pub fn create_shot(
    state: State<AppState>,
    section_id: SectionId,
    shot: ShotData,
    after_shot_id: Option<ShotId>,
    before_shot_id: Option<ShotId>,
) -> CommandResult
```

### Frontend store (`projectStore.ts`)
Update `createShot` to accept optional `beforeShotId` and return the result so callers can use `result.shot_id`:
```typescript
createShot: async (sectionId, shot, afterShotId?, beforeShotId?) => {
    const result = await invoke<CommandResult>('create_shot', {
        sectionId, shot, afterShotId: afterShotId ?? null, beforeShotId: beforeShotId ?? null
    });
    ...
    return result;
}
```

### Frontend types (`commands.ts`)
Add `shot_id?: number` to the `CommandResult` TypeScript interface.

### Undo handling
Existing `CreatedShotSnapshot` stores `position` which captures the actual insertion index. Verify it handles position 0 correctly for prepend case.

## Acceptance
- [ ] `Section::insert_shot_before(id, data)` inserts at the correct position
- [ ] `create_shot` Tauri command accepts `before_shot_id` parameter
- [ ] `CommandResult` has `shot_id: Option<ShotId>` field
- [ ] `create_shot` returns `shot_id` in ALL success paths (with and without warnings)
- [ ] `success_with_shot_id_and_warnings` constructor exists for warning + shot_id case
- [ ] Frontend `CommandResult` TypeScript type includes `shot_id?: number`
- [ ] Frontend store `createShot` can pass `beforeShotId` and returns result
- [ ] Undo/redo works correctly for prepended shots (position 0)
- [ ] Existing `after_shot_id` behavior unchanged
- [ ] All existing `CommandResult` constructors set `shot_id: None`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `pnpm tsc --noEmit` passes

## Done summary
Added insert_shot_before to Section/Project models, extended CreateShot with before_shot_id, added shot_id to CommandResult with success_with_shot_id and success_with_shot_id_and_warnings constructors, updated command execution to return shot_id in all success paths, updated Tauri command signature, frontend store and TypeScript types. All Rust tests pass, tsc --noEmit passes. Impl-review gave SHIP verdict.
## Evidence
- Commits: 73dd60d, b7d646f, c439a69
- Tests: cargo test --manifest-path src-tauri/Cargo.toml (770+80 passed, 0 failed), pnpm tsc --noEmit (clean)
- PRs: