# fn-22-hye.1 Implement MergeProjects backend command

## Description
Add a `MergeProjects` command to the backend that merges multiple CaveChef projects into a new output file. The command uses append mode (no smart merge), auto-renumbers section IDs to avoid conflicts, preserves all zero datums, station merges, and loop closures with remapped IDs, creates a NEW output file, and optionally archives the original files.

## Acceptance
- [x] Command added to Command enum
- [x] Merges all sections from source projects
- [x] Section IDs resolved (renumbered sequentially)
- [x] New file created at output_path
- [x] Originals archived (optional, with .archived suffix)
- [x] Tests pass

## Done summary
Implemented MergeProjects backend command:
- Added Command::MergeProjects variant with source_paths, output_path, output_name, archive_originals fields
- Implemented merge_projects() method in AppState that loads sources, appends sections with renumbered IDs, preserves zero datums/merges/closures/offsets, saves to new file using safe save pattern
- Added archive_project_file() helper to rename originals with .archived suffix
- Exposed merge_projects Tauri command to frontend
- Added 3 integration tests covering basic merge, zero datum preservation, and station merge preservation
## Evidence
- Commits:
- Tests: backend, typecheck
- PRs: