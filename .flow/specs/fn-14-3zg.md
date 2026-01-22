# Undo/Redo History Dropdown

## Overview

Add dropdown menus to Undo/Redo toolbar buttons showing recent actions with timestamps and diff previews. Users can hover to see history, click any item to undo/redo to that point, and navigate via keyboard.

## Scope

**In scope:**
- Backend: Timestamp field in UndoEntry, stack exposure commands, multi-step undo/redo
- Frontend: Dropdown component, detail preview popup, keyboard navigation
- Integration: Toolbar button modifications, chevron indicator
- Tests: E2E Playwright tests

**Out of scope:**
- Branching undo tree (linear history only)
- Touch device support (hover-based, revisit later)
- Configurable history limit (uses existing 100-entry limit)

## Architecture

### Data Flow
```
User hovers Undo → 300ms delay → invoke('get_undo_stack') → Render dropdown
User clicks item N → invoke('undo_to', {index: N}) → (N+1) undos execute → refreshProjectState()
```

### Index Semantics
- **Index 0 = most recent action** (top of stack, matches UI ordering)
- Undo stack: index 0 is the last action performed (first to undo)
- Redo stack: index 0 is the last undone action (first to redo)
- `undo_to(3)` means: undo items at indices 0, 1, 2, 3 (4 total undos)

### Key Files
- `src-tauri/src/core/undo.rs:23-29` - UndoEntry struct (add timestamp)
- `src-tauri/src/commands/history.rs` - Add get_undo_stack, undo_to commands
- `src-tauri/src/persistence/sqlite.rs` - Use existing executed_at column for timestamp
- `src/components/SingleSystemView/Toolbar.tsx:55-60` - Undo/Redo buttons
- `src/components/SingleSystemView/DisplayMenu.tsx` - Dropdown pattern to follow

### New Types
```typescript
// Frontend DTO
interface UndoHistoryItem {
  index: number;
  description: string;
  timestamp: string | null; // ISO 8601 or null for legacy entries
  commandType: string; // For icon mapping: "create_section", "delete_shot", etc.
  // Preview data included inline (no separate endpoint)
  previewData: {
    changes: Array<{ field: string; oldValue: string; newValue: string }>;
    additionalChanges: number; // Count of fields beyond the 3 shown
  } | null;
}
```

```rust
// Backend DTO
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoHistoryItem {
    pub index: usize,
    pub description: String,
    pub timestamp: Option<String>, // ISO 8601 or None for legacy
    pub command_type: String,
    pub preview_data: Option<PreviewData>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewData {
    pub changes: Vec<FieldChange>,
    pub additional_changes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldChange {
    pub field: String,
    pub old_value: String,
    pub new_value: String,
}
```

### Preview Data Derivation

Which commands provide `previewData`:

| Command Type | previewData | Fields Shown |
|--------------|-------------|--------------|
| UpdateShot | Yes | length, azimuth_in, depth_in (from UndoData::PreviousValues) |
| UpdateSectionMetadata | Yes | name, surveyor, date (from UndoData::PreviousValues) |
| CreateSection | Partial | name only (from command data) |
| CreateShot | Partial | length, azimuth (from command data) |
| DeleteSection | Yes | name, shot count (from UndoData::SectionSnapshot) |
| DeleteShot | Partial | length, azimuth (from UndoData::ShotSnapshot) |
| MergeStations | No | null (no meaningful diff) |
| UnmergeStations | No | null |
| SetZeroDatum | Partial | coordinates (from command) |
| RemoveZeroDatum | No | null |
| MoveSection | No | null (offset not useful) |
| MoveStation | No | null (position not useful) |
| Batch | Summary | "N operations" (from commands.len()) |

Commands with `previewData: null` show description only in the preview popup.

## Approach

1. **Backend first**: Add timestamp to UndoEntry, hydrate from executed_at column, expose stack via new commands
2. **Component shell**: Build dropdown with hover trigger, no preview yet
3. **Detail preview**: Add hover preview with positioning logic (data already in stack response)
4. **Keyboard nav**: Integrate with existing shortcut system
5. **Polish**: Animations, icons, truncation, scrolling

## Key Decisions

- **Timestamp storage**: `Option<DateTime<Utc>>` in UndoEntry; hydrate from sqlite `executed_at` column on load, store on save. Legacy entries without executed_at show as null in DTO (UI displays "Unknown")
- **Timestamp persistence**: Use existing `executed_at` column in sqlite - update `serialize_entry`/`deserialize_entry` and `load_undo_stack`/`save_undo_stack` to carry timestamps
- **Multi-step semantics**: Execute undos sequentially (not transactional) - partial state on failure is acceptable
- **Stack data**: Fetch on dropdown open (not eagerly) to avoid performance overhead
- **Preview data**: Included inline in `get_undo_stack`/`get_redo_stack` response (no separate endpoint); derivation rules in table above
- **Icons**: Text icons like existing toolbar - consistent with current design
- **Index ordering**: Index 0 = most recent (LIFO order preserved in DTO)
- **Dropdown close on shortcuts**: Dropdown closes when user presses Ctrl+Z/Y (global shortcuts)

## Risks

| Risk | Mitigation |
|------|------------|
| Stack changes while dropdown open | Close dropdown on Ctrl+Z/Y keyboard shortcuts |
| Large batch preview data | Collapse to summary for >5 items; additionalChanges count |
| Legacy entries without timestamps | Show "Unknown" in UI when timestamp is null |

## Quick Commands

```bash
# Run dev server
./scripts/dev.sh

# Type check
pnpm tsc --noEmit

# Run Playwright tests
pnpm test:ui

# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml

# Smoke test: hover undo button, verify dropdown appears
```

## Acceptance Criteria

- [ ] Hovering Undo/Redo buttons shows dropdown after 300ms delay
- [ ] Dropdown displays up to 10 recent actions, scrollable for more
- [ ] Each item shows icon, description (truncated at ~40 chars), and timestamp
- [ ] Clicking any item executes undo/redo to that point (index N = N+1 operations)
- [ ] Hovering items shows detail preview with diff (old to new values) where available
- [ ] Timestamps use smart hybrid format (relative <1 day, absolute otherwise); null shows "Unknown"
- [ ] Backend stores timestamp with each UndoEntry (uses executed_at column)
- [ ] Timestamps persist across app restarts via sqlite executed_at
- [ ] New Tauri commands: get_undo_stack, get_redo_stack, undo_to, redo_to
- [ ] Index 0 = most recent action in both stacks
- [ ] Buttons have small chevron indicator
- [ ] Keyboard: Arrow Down opens, arrows navigate, Enter selects, Escape closes
- [ ] Empty stacks don't show dropdown
- [ ] Preview flips to left if would overflow right edge
- [ ] Dropdown closes on Ctrl+Z/Y keyboard shortcuts

## References

- DisplayMenu.tsx pattern: `src/components/SingleSystemView/DisplayMenu.tsx:36-213`
- Escape key coordination: `src/hooks/useKeyboardShortcuts.ts:276` (data-dropdown-open)
- Command description method: `src-tauri/src/core/command.rs:216-297`
- SQLite persistence: `src-tauri/src/persistence/sqlite.rs` (executed_at column exists)
- date-fns formatDistanceToNow: https://date-fns.org/docs/formatDistanceToNow
- ARIA menu pattern: https://www.w3.org/WAI/ARIA/apg/patterns/menu/

## Doc Updates Needed

- SPEC.md Section 6.2: Document dropdown behavior
- SPEC.md Appendix A: Add dropdown keyboard shortcuts
- SPEC.md Section 8: Document timestamp field
- TESTING.md: Add dropdown testing section
