# Return section ID from create_section command

## Overview
Modify backend to return created section ID. Blocks fn-15-up5.

## Scope
- Update CommandResult to include section ID
- Return all IDs for batch create
- Update frontend types

## Quick commands
```bash
cd src-tauri && cargo test
pnpm tsc --noEmit
```

## Acceptance
- [ ] create_section returns ID
- [ ] Batch returns all IDs
- [ ] Frontend receives ID
- [ ] Types updated
- [ ] Tests pass

## References
- Task spec: `./tasks/task-14-return-section-id.md`
