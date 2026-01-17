# Add direction field to Section model

## Overview
Add IN/OUT direction enum to Section. HIGH RISK - database schema change.

## Scope
- Direction enum (In/Out)
- Database schema migration
- Default to IN
- Display in Import Dialog
- Editable

## Quick commands
```bash
cd src-tauri && cargo test
pnpm tsc --noEmit && pnpm test:ui
```

## Acceptance
- [ ] Direction field in Section
- [ ] Database migration
- [ ] Default IN
- [ ] Editable in Import Dialog
- [ ] Persists correctly
- [ ] Tests pass

## References
- Task spec: `./tasks/task-15-direction-field.md`
