# Plan: Fix Double Save on "Save now"

## Problem Summary

When creating a project from the New Project dialog and selecting "Save project file immediately" ("Save now"), the app writes two files:
1. A first file in the default Documents location.
2. A second file at the user-selected Save dialog location.

This leaves an unexpected duplicate project file on disk.

## Investigation Findings

### Confirmed call path
- `NewProjectDialog` calls `createProject(name, location)` before the optional save flow.
- `projectStore.createProject()` currently invokes backend `create_project_full`.
- Backend `create_project_full` (`do_create_project_full`) persists immediately to disk:
  - Uses `location` as optional save directory.
  - If `location` is `None`, resolves to user Documents directory.
- If "Save now" is checked, dialog then calls `saveProject(finalPath)`, causing the second write.

### Semantic mismatch
- Frontend dialog field `location` is cave metadata (free text like "Carlsbad Caverns...").
- Backend `create_project_full(location)` interprets this argument as a filesystem directory path.
- This mismatch is unsafe and can create unexpected directories/files.

## Desired Behavior

- Creating a project from New Project should create an in-memory unsaved project.
- Selecting "Save now" should produce exactly one on-disk file at the user-selected path.
- Cave `location` metadata should never be interpreted as a filesystem path.

## Implementation Plan

1. Split project creation flows by intent in frontend store.
   - `createProject` (default): call legacy `create_project` for in-memory unsaved project creation.
   - `createProjectFull` (explicit persisted path flow only): keep for cases that truly require immediate on-disk creation.

2. Update dialog usage.
   - `NewProjectDialog`: use in-memory `createProject`.
   - Keep current "Save now" sequence: create in-memory project -> open Save dialog -> call `saveProject(finalPath)` once.
   - `NewProjectForImportDialog`: use in-memory create path as well (same metadata semantics).

3. Harden API naming and call sites to prevent future misuse.
   - Rename frontend parameter names to reflect meaning (`projectLocation` vs `saveDirectory`).
   - Optionally rename backend `create_project_full` argument from `location` to `directory`/`save_dir` for clarity.
   - Update comments/docs where "location" is ambiguous.

4. Add regression tests.
   - Frontend unit test (`projectStore`): new-project flow uses `create_project` (not `create_project_full`).
   - Playwright test: "Save now" flow results in a single save command path (no implicit Documents save call).
   - Rust test (optional but recommended): ensure `create_project` leaves `file_path = None`; `save_project` sets it only after explicit save.

5. Validate behavior manually.
   - Create new project without "Save now": confirm title shows `(unsaved)` and no file appears in Documents.
   - Create new project with "Save now": confirm only selected path file exists.
   - Verify Save/Save As and auto-save behavior remain unchanged after first explicit save.

## Risk Notes

- If any existing workflow depends on immediate persisted creation (unlikely for dialog-driven new project), that flow should be migrated to explicit `createProjectFull` usage.
- Changing command usage can affect mocked IPC test fixtures; update mock handlers/assertions accordingly.
