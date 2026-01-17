# Add MergeProjects command to backend

## Overview
Backend command to merge two projects. HIGH RISK. Blocks fn-23, fn-24.

## Scope
- MergeProjects command
- Append mode (no smart merge)
- Auto-renumber IDs
- Keep all zero datums
- Create NEW file
- Archive originals

## Quick commands
```bash
cd src-tauri && cargo test
```

## Acceptance
- [ ] Command added
- [ ] Merges all sections
- [ ] IDs resolved
- [ ] New file created
- [ ] Originals archived
- [ ] Tests pass
