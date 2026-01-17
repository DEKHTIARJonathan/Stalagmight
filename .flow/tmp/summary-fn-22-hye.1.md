Implemented MergeProjects backend command:
- Added Command::MergeProjects variant with source_paths, output_path, output_name, archive_originals fields
- Implemented merge_projects() method in AppState that loads sources, appends sections with renumbered IDs, preserves zero datums/merges/closures/offsets, saves to new file using safe save pattern
- Added archive_project_file() helper to rename originals with .archived suffix
- Exposed merge_projects Tauri command to frontend
- Added 3 integration tests covering basic merge, zero datum preservation, and station merge preservation
