# fn-15-ygz.12 Add station_count to ProjectMetadata

## Description
Add `station_count` field to `ProjectMetadata` in both Rust backend and TypeScript types. This enables the MetadataPanel to show station count for multi-selection aggregate stats.

**Size:** S
**Files:** 
- `src-tauri/src/models/project.rs` (add field to struct)
- `src-tauri/src/commands/project.rs` (populate on load)
- `src/types/project.ts` (add TypeScript type)

## Approach

- Add `station_count: usize` to Rust `ProjectMetadata` struct
- Calculate count during `list_recent_projects` or project metadata extraction
- Update TypeScript `ProjectMetadata` interface to match
## Acceptance
- [ ] `station_count` field added to Rust `ProjectMetadata` struct
- [ ] Field populated correctly when loading project metadata
- [ ] TypeScript `ProjectMetadata` interface updated
- [ ] Existing tests pass
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
